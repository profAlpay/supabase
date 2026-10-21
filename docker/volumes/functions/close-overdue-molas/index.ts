// @ts-nocheck
// Supabase Edge (Deno).
// Cron (her 1 dk): planlanan_bitis <= now olan açık molaları kapatır + Expo push.
// Auth: x-cron-secret / Bearer CRON_SECRET
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.8';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type, x-cron-secret',
};

const ISTANBUL_OFFSET = '+03:00';

function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

function parseSureDakika(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

function istanbulCalendarDateKey(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Istanbul' }).format(now);
}

function istanbulDayBoundsFor(dateKey: string): { startIso: string; endIso: string } {
  const start = new Date(`${dateKey}T00:00:00.000${ISTANBUL_OFFSET}`);
  const end = new Date(`${dateKey}T23:59:59.999${ISTANBUL_OFFSET}`);
  return { startIso: start.toISOString(), endIso: end.toISOString() };
}

function sessionMinutes(baslangic: string, bitis: string | null, nowMs = Date.now()): number {
  const start = new Date(baslangic).getTime();
  if (!Number.isFinite(start)) return 0;
  const end = bitis ? new Date(bitis).getTime() : nowMs;
  if (!Number.isFinite(end) || end < start) return 0;
  return (end - start) / 60_000;
}

function clampedAutoBitisIso(baslangicZamani: string, sureDakika: number, nowMs = Date.now()): string {
  const start = new Date(baslangicZamani).getTime();
  if (!Number.isFinite(start)) return new Date(nowMs).toISOString();
  const limitEnd = start + sureDakika * 60_000;
  const clamped = Math.min(nowMs, Math.max(start, limitEnd));
  return new Date(clamped).toISOString();
}

function isAuthorized(req: Request): boolean {
  const secret = Deno.env.get('CRON_SECRET') ?? '';
  if (!secret) return false;
  const headerSecret = req.headers.get('x-cron-secret') ?? '';
  if (headerSecret && headerSecret === secret) return true;
  const auth = req.headers.get('Authorization') ?? '';
  if (auth.startsWith('Bearer ') && auth.slice(7) === secret) return true;
  return false;
}

type OpenRow = {
  id: string;
  personel_id: string;
  mola_kural_id: string;
  baslangic_zamani: string;
  planlanan_bitis: string | null;
};

async function isDailyQuotaExhausted(
  admin: ReturnType<typeof createClient>,
  personelId: string,
  kuralId: string,
  gunluk: number,
  nowMs: number
): Promise<boolean> {
  const dateKey = istanbulCalendarDateKey(new Date(nowMs));
  const { startIso, endIso } = istanbulDayBoundsFor(dateKey);
  const { data } = await admin
    .from('mola_kayitlari')
    .select('baslangic_zamani, bitis_zamani')
    .eq('personel_id', personelId)
    .eq('mola_kural_id', kuralId)
    .not('bitis_zamani', 'is', null)
    .gte('baslangic_zamani', startIso)
    .lte('baslangic_zamani', endIso);

  let used = 0;
  for (const r of data ?? []) {
    used += sessionMinutes(r.baslangic_zamani, r.bitis_zamani, nowMs);
  }
  return used >= gunluk - 0.01;
}

async function sendExpoPush(
  admin: ReturnType<typeof createClient>,
  personelId: string,
  title: string,
  body: string,
  data: Record<string, unknown>
): Promise<{ delivered: number; tokens: number }> {
  const { data: tokens, error: tokenErr } = await admin
    .from('push_tokens')
    .select('token')
    .eq('personel_id', personelId);

  if (tokenErr) {
    console.error('[close-overdue-molas] push_tokens', tokenErr.message);
    return { delivered: 0, tokens: 0 };
  }

  const list = (tokens ?? [])
    .map((t) => String(t.token ?? '').trim())
    .filter((t) => t.length > 0);
  if (list.length === 0) {
    console.warn('[close-overdue-molas] no push token for personel', personelId);
    return { delivered: 0, tokens: 0 };
  }

  let delivered = 0;
  for (let i = 0; i < list.length; i += 100) {
    const chunk = list.slice(i, i + 100);
    const payload = chunk.map((to) => ({
      to,
      title,
      body,
      sound: 'default',
      priority: 'high',
      channelId: 'mola',
      data,
    }));

    try {
      const resp = await fetch('https://exp.host/--/api/v2/push/send', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'Accept-Encoding': 'gzip, deflate',
        },
        body: JSON.stringify(payload),
      });
      const respJson = await resp.json().catch(() => null);
      const tickets = respJson?.data as
        | Array<{ status: string; message?: string; details?: { error?: string } }>
        | undefined;
      if (resp.ok && Array.isArray(tickets)) {
        tickets.forEach((ticket, idx) => {
          if (ticket.status === 'ok') delivered += 1;
          else {
            console.error(
              '[close-overdue-molas] ticket fail',
              chunk[idx],
              ticket.message,
              ticket.details?.error
            );
          }
        });
      } else {
        console.error('[close-overdue-molas] expo push', resp.status, JSON.stringify(respJson));
      }
    } catch (e) {
      console.error('[close-overdue-molas] expo push failed', e);
    }
  }
  return { delivered, tokens: list.length };
}

async function notifyClosed(
  admin: ReturnType<typeof createClient>,
  row: OpenRow,
  gunluk: number | null,
  nowMs: number,
  counters: { notified: number; tokensFound: number }
): Promise<void> {
  let quotaExhausted = true;
  if (gunluk != null) {
    quotaExhausted = await isDailyQuotaExhausted(
      admin,
      row.personel_id,
      row.mola_kural_id,
      gunluk,
      nowMs
    );
  }
  const title = quotaExhausted ? 'Daha fazla molanız kalmadı' : 'Molanız bitti';
  const body = quotaExhausted
    ? 'Bugünkü mola süreniz doldu.'
    : 'Mola süreniz doldu. İyi çalışmalar.';
  const n = await sendExpoPush(admin, row.personel_id, title, body, {
    type: quotaExhausted ? 'mola_quota_exhausted' : 'mola_end',
    molaKayitId: row.id,
  });
  counters.tokensFound += n.tokens;
  counters.notified += n.delivered;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  if (req.method !== 'POST' && req.method !== 'GET') {
    return jsonResponse({ ok: false, message: 'Method not allowed' }, 405);
  }

  if (!isAuthorized(req)) {
    return jsonResponse(
      { ok: false, message: 'Unauthorized — x-cron-secret veya Bearer CRON_SECRET gerekli' },
      401
    );
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  if (!supabaseUrl || !serviceKey) {
    return jsonResponse({ ok: false, message: 'Edge ortam değişkenleri eksik.' }, 500);
  }

  const admin = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();

  // 1) Timer dolmuş: planlanan_bitis <= now
  const { data: dueRows, error: dueErr } = await admin
    .from('mola_kayitlari')
    .select('id, personel_id, mola_kural_id, baslangic_zamani, planlanan_bitis')
    .is('bitis_zamani', null)
    .not('planlanan_bitis', 'is', null)
    .lte('planlanan_bitis', nowIso)
    .order('planlanan_bitis', { ascending: true })
    .limit(500);

  if (dueErr) {
    return jsonResponse({ ok: false, message: dueErr.message }, 500);
  }

  // 2) Fallback: planlanan_bitis null eski açık kayıtlar
  const { data: legacyRows, error: legacyErr } = await admin
    .from('mola_kayitlari')
    .select('id, personel_id, mola_kural_id, baslangic_zamani, planlanan_bitis')
    .is('bitis_zamani', null)
    .is('planlanan_bitis', null)
    .order('baslangic_zamani', { ascending: true })
    .limit(200);

  if (legacyErr) {
    console.warn('[close-overdue-molas] legacy query', legacyErr.message);
  }

  const rows = [...((dueRows ?? []) as OpenRow[]), ...((legacyRows ?? []) as OpenRow[])];
  let closed = 0;
  let skipped = 0;
  let backfilled = 0;
  const counters = { notified: 0, tokensFound: 0 };
  const errors: string[] = [];
  const skipReasons: string[] = [];
  const closedMolaIds: string[] = [];
  const closedPersonelIds: string[] = [];

  const gunlukCache = new Map<string, number | null>();
  const usedCache = new Map<string, number>();

  async function getGunluk(kuralId: string): Promise<number | null> {
    if (gunlukCache.has(kuralId)) return gunlukCache.get(kuralId) ?? null;
    const { data } = await admin
      .from('mola_kurallari')
      .select('gunluk_dakika')
      .eq('id', kuralId)
      .maybeSingle();
    const gunluk = parseSureDakika(data?.gunluk_dakika);
    gunlukCache.set(kuralId, gunluk);
    return gunluk;
  }

  async function getUsedCompleted(
    personelId: string,
    kuralId: string,
    dateKey: string
  ): Promise<number> {
    const cacheKey = `${personelId}:${kuralId}:${dateKey}`;
    if (usedCache.has(cacheKey)) return usedCache.get(cacheKey) ?? 0;
    const { startIso, endIso } = istanbulDayBoundsFor(dateKey);
    const { data } = await admin
      .from('mola_kayitlari')
      .select('baslangic_zamani, bitis_zamani')
      .eq('personel_id', personelId)
      .eq('mola_kural_id', kuralId)
      .not('bitis_zamani', 'is', null)
      .gte('baslangic_zamani', startIso)
      .lte('baslangic_zamani', endIso);
    let used = 0;
    for (const r of data ?? []) {
      used += sessionMinutes(r.baslangic_zamani, r.bitis_zamani, nowMs);
    }
    usedCache.set(cacheKey, used);
    return used;
  }

  for (const row of rows) {
    try {
      if (!row.personel_id || !row.mola_kural_id || !row.baslangic_zamani) {
        skipped += 1;
        skipReasons.push(`${row.id}: eksik alan`);
        continue;
      }

      const gunluk = await getGunluk(row.mola_kural_id);
      let bitisIso: string;
      let planlanan = row.planlanan_bitis;

      // Legacy: planlanan_bitis yoksa hesapla + DB'ye yaz (sonraki cron due_with_timer görsün)
      if (!planlanan) {
        if (gunluk == null) {
          skipped += 1;
          skipReasons.push(`${row.id}: gunluk_dakika yok`);
          continue;
        }
        const dateKey = istanbulCalendarDateKey(new Date(row.baslangic_zamani));
        const usedCompleted = await getUsedCompleted(row.personel_id, row.mola_kural_id, dateKey);
        let sessionLimit = gunluk - Math.max(0, usedCompleted);
        if (sessionLimit <= 0) {
          const elapsed = sessionMinutes(row.baslangic_zamani, null, nowMs);
          sessionLimit = Math.max(0.01, Math.min(elapsed, gunluk));
        }
        const startMs = new Date(row.baslangic_zamani).getTime();
        if (!Number.isFinite(startMs)) {
          skipped += 1;
          skipReasons.push(`${row.id}: baslangic geçersiz`);
          continue;
        }
        planlanan = new Date(startMs + sessionLimit * 60_000).toISOString();
        const { error: fillErr } = await admin
          .from('mola_kayitlari')
          .update({ planlanan_bitis: planlanan })
          .eq('id', row.id)
          .is('bitis_zamani', null)
          .is('planlanan_bitis', null);
        if (fillErr) {
          errors.push(`${row.id}: backfill ${fillErr.message}`);
        } else {
          backfilled += 1;
        }
        if (nowMs < startMs + sessionLimit * 60_000) {
          skipped += 1;
          const remainSec = Math.ceil((startMs + sessionLimit * 60_000 - nowMs) / 1000);
          skipReasons.push(`${row.id}: henüz dolmadı (~${remainSec}s), timer yazıldı`);
          continue;
        }
        bitisIso = clampedAutoBitisIso(row.baslangic_zamani, sessionLimit, nowMs);
      } else {
        const planned = new Date(planlanan).getTime();
        const start = new Date(row.baslangic_zamani).getTime();
        if (!Number.isFinite(planned) || !Number.isFinite(start)) {
          skipped += 1;
          skipReasons.push(`${row.id}: planlanan_bitis geçersiz`);
          continue;
        }
        if (nowMs < planned) {
          skipped += 1;
          skipReasons.push(
            `${row.id}: henüz dolmadı (~${Math.ceil((planned - nowMs) / 1000)}s)`
          );
          continue;
        }
        bitisIso = new Date(Math.min(nowMs, Math.max(start, planned))).toISOString();
      }

      const { data, error } = await admin
        .from('mola_kayitlari')
        .update({ bitis_zamani: bitisIso })
        .eq('id', row.id)
        .is('bitis_zamani', null)
        .select('id')
        .maybeSingle();

      if (error) {
        errors.push(`${row.id}: ${error.message}`);
        continue;
      }
      if (!data) {
        skipped += 1;
        skipReasons.push(`${row.id}: concurrent close`);
        continue;
      }

      closed += 1;
      closedPersonelIds.push(row.personel_id);
      closedMolaIds.push(row.id);
      const dateKey = istanbulCalendarDateKey(new Date(row.baslangic_zamani));
      usedCache.delete(`${row.personel_id}:${row.mola_kural_id}:${dateKey}`);

      console.log('[close-overdue-molas] closed', {
        id: row.id,
        personel_id: row.personel_id,
        planlanan_bitis: planlanan,
        bitisIso,
      });

      await notifyClosed(admin, row, gunluk, nowMs, counters);
    } catch (e) {
      errors.push(`${row.id}: ${e?.message ?? String(e)}`);
    }
  }

  console.log('[close-overdue-molas] summary', {
    scanned: rows.length,
    closed,
    skipped,
    backfilled,
    push_tokens_found: counters.tokensFound,
    push_delivered: counters.notified,
  });

  return jsonResponse({
    ok: true,
    scanned: rows.length,
    due_with_timer: (dueRows ?? []).length,
    legacy_open: (legacyRows ?? []).length,
    closed,
    skipped,
    backfilled,
    closed_mola_ids: closedMolaIds,
    closed_personel_ids: [...new Set(closedPersonelIds)],
    push_tokens_found: counters.tokensFound,
    push_delivered: counters.notified,
    skip_reasons: skipReasons.slice(0, 20),
    errors: errors.slice(0, 20),
    hint:
      closed === 0 && skipped > 0
        ? 'Mola henüz dolmamış veya planlanan_bitis yazılamadı — skip_reasons bak'
        : closed > 0 && counters.tokensFound === 0
          ? 'Molalar kapandı ama push_tokens boş — uygulamada bildirim izni ver, tekrar aç'
          : closed > 0 && counters.notified === 0
            ? 'Token var ama Expo push iletilemedi — Function Logs bak'
            : undefined,
  });
});
