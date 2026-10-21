// @ts-nocheck
// Supabase Edge (Deno). Expo TS / URL import / Deno.serve burada denetlenmez.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.8';

type TargetType = 'all' | 'departman' | 'personel';

type PersonelRow = {
  id: string;
  departman_id: string | null;
};

type TokenRow = {
  personel_id: string;
  token: string;
};

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

function jsonResponse(body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
  const supabaseAnon = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

  if (!supabaseUrl || !supabaseAnon || !serviceKey) {
    return jsonResponse({ ok: false, message: 'Edge ortam değişkenleri eksik (URL / ANON_KEY / SERVICE_ROLE).' });
  }

  if (req.method !== 'POST') {
    return jsonResponse({ ok: false, message: 'Method not allowed' });
  }

  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return jsonResponse({ ok: false, message: 'Oturum bulunamadı.' });
    }

    let body: {
      title?: string;
      message?: string;
      target_type?: TargetType;
      departman_id?: string;
      personel_ids?: string[];
    };
    try {
      body = await req.json();
    } catch {
      return jsonResponse({ ok: false, message: 'Geçersiz istek gövdesi.' });
    }

    const title = body.title?.trim();
    const message = body.message?.trim();
    const target_type = body.target_type;
    const departman_id = body.departman_id?.trim() || null;
    const personel_ids = Array.isArray(body.personel_ids) ? body.personel_ids.filter(Boolean) : [];

    if (!title || !message || !target_type || !['all', 'departman', 'personel'].includes(target_type)) {
      return jsonResponse({ ok: false, message: 'Eksik veya geçersiz istek.' });
    }
    if (target_type === 'departman' && !departman_id) {
      return jsonResponse({ ok: false, message: 'Departman seçimi gerekli.' });
    }
    if (target_type === 'personel' && personel_ids.length === 0) {
      return jsonResponse({ ok: false, message: 'En az bir personel seçilmeli.' });
    }

    const userClient = createClient(supabaseUrl, supabaseAnon, {
      global: { headers: { Authorization: authHeader } },
    });
    const {
      data: { user },
      error: userErr,
    } = await userClient.auth.getUser();
    if (userErr || !user?.id) {
      return jsonResponse({ ok: false, message: 'Oturum doğrulanamadı.' });
    }

    const admin = createClient(supabaseUrl, serviceKey);

    const { data: caller, error: callerErr } = await admin
      .from('personeller')
      .select('id, role, departman_id')
      .eq('auth_user_id', user.id)
      .maybeSingle();

    if (callerErr || !caller) {
      return jsonResponse({ ok: false, message: 'Personel bulunamadı.' });
    }

    const isAdmin = caller.role === 'admin';
    const isMudur = caller.role === 'müdür';
    const isSef = caller.role === 'şef';
    if (!isAdmin && !isMudur && !isSef) {
      return jsonResponse({ ok: false, message: 'Bu işlem için yetkiniz yok.' });
    }

    /** Şef: bildirimler yazma yetkisi + yalnızca sorumlu personeller */
    let sefAllowedIds: Set<string> | null = null;
    if (isSef) {
      const { data: yetkiRow, error: yetkiErr } = await admin
        .from('sef_yetkileri')
        .select('bildirimler')
        .eq('sef_id', caller.id)
        .maybeSingle();

      if (yetkiErr) {
        return jsonResponse({ ok: false, message: 'Şef yetkisi okunamadı: ' + yetkiErr.message });
      }

      const level = yetkiRow?.bildirimler;
      const canWrite =
        level === 'write' || level === true; // true: boolean şema kalıntısı
      if (!canWrite) {
        return jsonResponse({ ok: false, message: 'Bildirim gönderme yetkiniz yok.' });
      }

      if (target_type !== 'personel') {
        return jsonResponse({
          ok: false,
          message: 'Şefler yalnızca sorumlu personellere bildirim gönderebilir.',
        });
      }

      const { data: sorumluRows, error: sorErr } = await admin
        .from('sef_sorumluluklari')
        .select('personel_id')
        .eq('sef_id', caller.id);

      if (sorErr) {
        return jsonResponse({ ok: false, message: 'Sorumluluk listesi okunamadı: ' + sorErr.message });
      }

      sefAllowedIds = new Set(
        (sorumluRows ?? []).map((r: { personel_id: string }) => r.personel_id).filter(Boolean),
      );

      const outside = personel_ids.filter((id) => !sefAllowedIds!.has(id));
      if (outside.length > 0) {
        return jsonResponse({
          ok: false,
          message: 'Yalnızca sorumlu olduğunuz personellere bildirim gönderebilirsiniz.',
        });
      }
    }

    // Müdür sadece kendi departmanına gönderebilir
    if (isMudur) {
      if (target_type === 'all') {
        return jsonResponse({ ok: false, message: 'Müdürler sadece kendi departmanına bildirim gönderebilir.' });
      }
      if (target_type === 'departman' && departman_id !== caller.departman_id) {
        return jsonResponse({ ok: false, message: 'Sadece kendi departmanınıza bildirim gönderebilirsiniz.' });
      }
    }

    // Hedef personel listesini resolve et
    let targetQuery = admin.from('personeller').select('id, departman_id').eq('is_active', true);
    if (target_type === 'departman') {
      targetQuery = targetQuery.eq('departman_id', departman_id);
    } else if (target_type === 'personel') {
      targetQuery = targetQuery.in('id', personel_ids);
    }

    const { data: targets, error: targetsErr } = await targetQuery;
    if (targetsErr) {
      return jsonResponse({ ok: false, message: 'Hedef personel sorgusu başarısız: ' + targetsErr.message });
    }

    let finalTargets = (targets ?? []) as PersonelRow[];
    if (isMudur) {
      finalTargets = finalTargets.filter((t) => t.departman_id === caller.departman_id);
    }
    if (isSef && sefAllowedIds) {
      finalTargets = finalTargets.filter((t) => sefAllowedIds!.has(t.id));
    }

    if (finalTargets.length === 0) {
      return jsonResponse({ ok: false, message: 'Gönderilecek personel bulunamadı.' });
    }

    const { data: notif, error: notifErr } = await admin
      .from('notifications')
      .insert({
        title,
        message,
        sent_by: caller.id,
        target_type,
        departman_id: target_type === 'departman' ? departman_id : null,
      })
      .select('id')
      .single();

    if (notifErr || !notif) {
      return jsonResponse({ ok: false, message: 'Bildirim oluşturulamadı: ' + (notifErr?.message ?? '') });
    }

    const recipientRows = finalTargets.map((t) => ({ notification_id: notif.id, personel_id: t.id }));
    const { error: recErr } = await admin.from('notification_recipients').insert(recipientRows);
    if (recErr) {
      return jsonResponse({ ok: false, message: 'Alıcı kayıtları oluşturulamadı: ' + recErr.message });
    }

    const targetIds = finalTargets.map((t) => t.id);
    const { data: tokens } = await admin
      .from('push_tokens')
      .select('personel_id, token')
      .in('personel_id', targetIds);

    const tokenList = (tokens ?? []) as TokenRow[];
    let deliveredCount = 0;

    if (tokenList.length > 0) {
      const chunks: TokenRow[][] = [];
      for (let i = 0; i < tokenList.length; i += 100) {
        chunks.push(tokenList.slice(i, i + 100));
      }

      for (const chunk of chunks) {
        const payload = chunk.map((t) => ({
          to: t.token,
          title,
          body: message,
          sound: 'default',
          data: { notification_id: notif.id },
        }));

        try {
          const resp = await fetch('https://exp.host/--/api/v2/push/send', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify(payload),
          });
          const respJson = await resp.json().catch(() => null);
          const tickets = respJson?.data as
            | Array<{ status: string; message?: string; details?: { error?: string } }>
            | undefined;

          if (!resp.ok || !tickets) {
            console.error('Expo push API hatası', resp.status, JSON.stringify(respJson));
          } else {
            const deliveredPersonelIds: string[] = [];
            tickets.forEach((ticket, i) => {
              if (ticket.status === 'ok') {
                deliveredCount += 1;
                deliveredPersonelIds.push(chunk[i].personel_id);
              } else {
                // Expo'nun 200 döndürüp içeride başarısız ticket bildirdiği durumlar
                // (ör. iOS için InvalidCredentials/DeviceNotRegistered) burada görünür olur.
                console.error(
                  'Expo push ticket hatası',
                  chunk[i].personel_id,
                  ticket.message,
                  ticket.details?.error,
                );
              }
            });
            if (deliveredPersonelIds.length > 0) {
              await admin
                .from('notification_recipients')
                .update({ delivered: true })
                .eq('notification_id', notif.id)
                .in('personel_id', deliveredPersonelIds);
            }
          }
        } catch (e) {
          console.error('Expo push API isteği başarısız', e);
        }
      }
    }

    return jsonResponse({
      ok: true,
      message: `Bildirim ${finalTargets.length} personele gönderildi (${deliveredCount} push bildirimi iletildi).`,
      recipient_count: finalTargets.length,
      delivered_count: deliveredCount,
    });
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e);
    console.error(e);
    return jsonResponse({ ok: false, message: `Sunucu hatası: ${errMsg}` });
  }
});
