// Supabase Edge Function: delete-user-webhook
//
// public.personeller üzerindeki bir Database Webhook (AFTER DELETE) tarafından
// tetiklenir. Silinen personel satırının auth_user_id'si varsa, ilgili
// auth.users kaydını service_role ile temizler. Böylece personeller satırı
// HANGİ yoldan silinirse silinsin (panel, ileride eklenecek toplu silme,
// manuel SQL) auth.users tarafında yetim kayıt kalmaz.
//
// Neden istemci tarafında değil: tarayıcıdaki anon-key istemcisi
// auth.admin.* çağıramaz (yalnızca service_role ile çalışır) — bkz.
// app/dashboard/kullanicilar/page.tsx içindeki eski (kaldırılan) deneme.
//
// Güvenlik: verify_jwt KAPALI deploy edilmeli, çünkü personeller SELECT RLS
// politikası "herkes okuyabilir" (USING true) — yani herhangi bir
// authenticated kullanıcı (düşük yetkili "personel" rolü dahil) başka bir
// kullanıcının auth_user_id'sini okuyabilir. Varsayılan verify_jwt açık
// kalsaydı, geçerli HERHANGİ bir JWT (anon key dahil) bu fonksiyonu doğrudan
// çağırıp keyfi bir hesabı sildirebilirdi. Bunun yerine Authorization
// header'ının WEBHOOK_SHARED_SECRET'a birebir eşit olduğunu elle doğruluyoruz.
//
// ÖNEMLİ: Bu kontrol için SUPABASE_SERVICE_ROLE_KEY KULLANILMAZ. Bazı
// projelerde Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ile registry/tenants
// tablosunda saklanan (eski, JWT tabanlı) service_role anahtarı FARKLI
// değerler olabiliyor (Supabase'in yeni/kısa formatlı anahtar sistemi).
// Bu yüzden yetkilendirme için WEBHOOK_SHARED_SECRET adında ayrı, projeye
// özel bir sır kullanılır — SUPABASE_SERVICE_ROLE_KEY yalnızca bu
// fonksiyonun kendi auth.admin.deleteUser() çağrısı için kullanılır.
//
// Kurulum (kiracı başına):
//   1. Rastgele bir sır üretin: openssl rand -hex 32
//   2. Fonksiyona secret olarak tanımlayın:
//        supabase secrets set WEBHOOK_SHARED_SECRET=<uretilen-deger> --project-ref <tenant-ref>
//   3. Deploy edin:
//        supabase functions deploy delete-user-webhook --project-ref <tenant-ref> --no-verify-jwt
//   4. AYNI değeri veritabanı tetikleyicisinin okuduğu Vault secret'ına da yazın
//      (bkz. database/add_personel_delete_webhook.sql).

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

interface PersonelWebhookPayload {
  type: 'INSERT' | 'UPDATE' | 'DELETE';
  table: string;
  schema: string;
  record: Record<string, unknown> | null;
  old_record: { auth_user_id?: string | null; [key: string]: unknown } | null;
}

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
// Trigger tarafında Vault'taki 'delete_user_webhook_shared_secret' ile AYNI olmalı.
const WEBHOOK_SHARED_SECRET = Deno.env.get('WEBHOOK_SHARED_SECRET') ?? '';

function jsonResponse(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') {
    return jsonResponse(405, { error: 'Method not allowed' });
  }

  const authHeader = req.headers.get('Authorization') ?? '';
  if (!WEBHOOK_SHARED_SECRET || authHeader !== `Bearer ${WEBHOOK_SHARED_SECRET}`) {
    console.error('delete-user-webhook: reddedildi - Authorization eslesmedi');
    return jsonResponse(401, { error: 'Unauthorized' });
  }

  let payload: PersonelWebhookPayload;
  try {
    payload = await req.json();
  } catch (e) {
    console.error('delete-user-webhook: govde JSON parse edilemedi', e);
    return jsonResponse(400, { error: 'Invalid JSON body' });
  }

  if (payload.type !== 'DELETE' || payload.table !== 'personeller') {
    return jsonResponse(200, { skipped: true, reason: 'not a personeller DELETE event' });
  }

  const authUserId = payload.old_record?.auth_user_id;
  if (!authUserId) {
    // Bu personelin dashboard auth hesabı yoktu (ör. yalnızca device_id ile
    // mobil giriş yapan personel) — temizlenecek auth.users kaydı yok.
    return jsonResponse(200, { skipped: true, reason: 'no auth_user_id on deleted row' });
  }

  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
    console.error('delete-user-webhook: SUPABASE_URL veya SUPABASE_SERVICE_ROLE_KEY eksik');
    return jsonResponse(500, { error: 'Server misconfigured' });
  }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { error } = await admin.auth.admin.deleteUser(authUserId as string);

  if (error) {
    const status = (error as { status?: number }).status;
    const alreadyGone =
      status === 404 ||
      /not.?found/i.test(error.message ?? '') ||
      /user.*not.*exist/i.test(error.message ?? '');

    if (alreadyGone) {
      // Zaten silinmiş / hiç var olmamış — idempotent başarı.
      return jsonResponse(200, { ok: true, alreadyDeleted: true, authUserId });
    }

    console.error('delete-user-webhook: auth.admin.deleteUser basarisiz', {
      authUserId,
      message: error.message,
      status,
    });
    return jsonResponse(502, { error: 'auth.admin.deleteUser failed', detail: error.message });
  }

  return jsonResponse(200, { ok: true, authUserId });
});
