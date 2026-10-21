// @ts-nocheck
// Supabase Edge (Deno). Expo TS / URL import / Deno.serve burada denetlenmez.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.8';

type EventType = 'enter' | 'exit';

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

    let body: { watch_target_id?: string; event_type?: EventType };
    try {
      body = await req.json();
    } catch {
      return jsonResponse({ ok: false, message: 'Geçersiz istek gövdesi.' });
    }

    const watchTargetId = body.watch_target_id?.trim();
    const eventType = body.event_type;
    if (!watchTargetId || !eventType || !['enter', 'exit'].includes(eventType)) {
      return jsonResponse({ ok: false, message: 'Eksik veya geçersiz istek.' });
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
      .select('id, name')
      .eq('auth_user_id', user.id)
      .maybeSingle();

    if (callerErr || !caller) {
      return jsonResponse({ ok: false, message: 'Personel bulunamadı.' });
    }

    // Watch hedefi gerçekten bu çağıran kişiye mi ait — başkasının watch ID'si taklit edilemesin.
    const { data: watch, error: watchErr } = await admin
      .from('watch_targets')
      .select('id, personel_id, is_active, label')
      .eq('id', watchTargetId)
      .maybeSingle();

    if (watchErr || !watch || watch.personel_id !== caller.id || !watch.is_active) {
      return jsonResponse({ ok: false, message: 'Watch hedefi bulunamadı veya yetkisiz.' });
    }

    const { data: recipients, error: recipientsErr } = await admin
      .from('watch_recipients')
      .select('personel_id')
      .eq('watch_target_id', watchTargetId);

    if (recipientsErr) {
      return jsonResponse({ ok: false, message: 'Alıcılar okunamadı: ' + recipientsErr.message });
    }

    const recipientIds = (recipients ?? []).map((r) => r.personel_id);
    if (recipientIds.length === 0) {
      return jsonResponse({ ok: true, message: 'Alıcı tanımlı değil.', recipient_count: 0 });
    }

    const displayName = watch.label || caller.name;
    const title = eventType === 'exit' ? 'Çember Uyarısı: Bölgeden Çıkış' : 'Çember Uyarısı: Bölgeye Giriş';
    const message =
      eventType === 'exit'
        ? `${displayName} tanımlı alanın dışına çıktı.`
        : `${displayName} tanımlı alana geri girdi.`;

    const { data: notif, error: notifErr } = await admin
      .from('notifications')
      .insert({
        title,
        message,
        sent_by: null,
        target_type: 'personel',
        departman_id: null,
      })
      .select('id')
      .single();

    if (notifErr || !notif) {
      return jsonResponse({ ok: false, message: 'Bildirim oluşturulamadı: ' + (notifErr?.message ?? '') });
    }

    const recipientRows = recipientIds.map((id) => ({ notification_id: notif.id, personel_id: id }));
    const { error: recErr } = await admin.from('notification_recipients').insert(recipientRows);
    if (recErr) {
      return jsonResponse({ ok: false, message: 'Alıcı kayıtları oluşturulamadı: ' + recErr.message });
    }

    const { data: tokens } = await admin
      .from('push_tokens')
      .select('personel_id, token')
      .in('personel_id', recipientIds);

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
      message: `Watch alert ${recipientIds.length} alıcıya gönderildi (${deliveredCount} push iletildi).`,
      recipient_count: recipientIds.length,
      delivered_count: deliveredCount,
    });
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e);
    console.error(e);
    return jsonResponse({ ok: false, message: `Sunucu hatası: ${errMsg}` });
  }
});
