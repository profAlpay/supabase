// @ts-nocheck
// Supabase Edge (Deno). Expo TS / URL import / Deno.serve burada denetlenmez.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.8';

type DepartmanRow = {
  id: string;
  name: string;
  latitude: number | null;
  longitude: number | null;
  radius: number | null;
};

type QrRecentRow = {
  id: string;
  created_at: string;
  type: string;
};

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000;
  const p1 = (lat1 * Math.PI) / 180;
  const p2 = (lat2 * Math.PI) / 180;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(p1) * Math.cos(p2) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function istanbulDateString(isoTimestamp: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Istanbul' }).format(new Date(isoTimestamp));
}

function todayIstanbulString(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Istanbul' }).format(new Date());
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
  const supabaseAnon = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

  if (!supabaseUrl || !supabaseAnon || !serviceKey) {
    return new Response(
      JSON.stringify({ ok: false, message: 'Edge ortam değişkenleri eksik (URL / ANON_KEY / SERVICE_ROLE).' }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ ok: false, message: 'Method not allowed' }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return new Response(JSON.stringify({ ok: false, message: 'Oturum bulunamadı.' }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    let body: {
      qr_token?: string;
      lat?: number;
      lng?: number;
      device_id?: string;
    };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return new Response(JSON.stringify({ ok: false, message: 'Geçersiz istek gövdesi.' }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const qr_token = body.qr_token?.trim();
    const lat = body.lat;
    const lng = body.lng;
    const device_id = body.device_id?.trim() ?? null;

    if (!qr_token || lat === undefined || lng === undefined || Number.isNaN(lat) || Number.isNaN(lng)) {
      return new Response(JSON.stringify({ ok: false, message: 'Eksik veya geçersiz istek.' }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const userClient = createClient(supabaseUrl, supabaseAnon, {
      global: { headers: { Authorization: authHeader } },
    });
    const {
      data: { user },
      error: userErr,
    } = await userClient.auth.getUser();
    if (userErr || !user?.id) {
      return new Response(JSON.stringify({ ok: false, message: 'Oturum doğrulanamadı.' }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const admin = createClient(supabaseUrl, serviceKey);

    const { data: personel, error: pErr } = await admin
      .from('personeller')
      .select('id, device_id, auth_user_id')
      .eq('auth_user_id', user.id)
      .maybeSingle();

    if (pErr || !personel) {
      return new Response(JSON.stringify({ ok: false, message: 'Personel bulunamadı.' }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (personel.device_id) {
      if (!device_id || personel.device_id !== device_id) {
        return new Response(JSON.stringify({ ok: false, message: 'Bu hesap başka bir cihaza kayıtlı veya cihaz doğrulanamadı.' }), {
          status: 200,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
    }

    const parts = qr_token.split(':');
    if (parts.length < 3) {
      return new Response(JSON.stringify({ ok: false, message: 'Geçersiz QR kodu.' }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const rawKey = parts[1].trim();
    const uuidRe =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

    let departman: DepartmanRow | null = null;

    if (uuidRe.test(rawKey)) {
      const byId = await admin
        .from('departmanlar')
        .select('id, name, latitude, longitude, radius')
        .eq('id', rawKey)
        .maybeSingle();
      departman = (byId.data ?? null) as DepartmanRow | null;
    }
    if (!departman) {
      const byName = await admin
        .from('departmanlar')
        .select('id, name, latitude, longitude, radius')
        .eq('name', rawKey)
        .limit(1)
        .maybeSingle();
      departman = (byName.data ?? null) as DepartmanRow | null;
    }

    if (!departman) {
      return new Response(JSON.stringify({ ok: false, message: 'Departman bulunamadı.' }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const dLat = departman.latitude != null ? Number(departman.latitude) : null;
    const dLon = departman.longitude != null ? Number(departman.longitude) : null;
    const radiusM = departman.radius != null ? Number(departman.radius) : 500;

    if (dLat != null && dLon != null && !Number.isNaN(dLat) && !Number.isNaN(dLon)) {
      const distance = haversineMeters(lat, lng, dLat, dLon);
      if (distance > radiusM) {
        return new Response(
          JSON.stringify({
            ok: false,
            message: `İzin verilen alan dışındasınız (${Math.round(distance)} m). En fazla ${radiusM} m.`,
          }),
          { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
    }

    const today = todayIstanbulString();

    const { data: recentRows } = await admin
      .from('qr_records')
      .select('id, created_at, type')
      .eq('personel_id', personel.id)
      // Arşivlenen / iptal edilen (is_active=false) kayıtlar giriş/çıkış sırasını etkilemesin
      .or('is_active.is.null,is_active.eq.true')
      .order('created_at', { ascending: false })
      .limit(25);

    const lastToday = (recentRows as QrRecentRow[] | null | undefined)?.find(
      (r: QrRecentRow) => istanbulDateString(r.created_at) === today
    );

    if (lastToday) {
      const ageMs = Date.now() - new Date(lastToday.created_at).getTime();
      if (ageMs < 2000) {
        return new Response(JSON.stringify({ ok: false, message: 'Çok hızlı tekrar. Bir an bekleyin.' }), {
          status: 200,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
    }

    let nextType: 'giris' | 'cikis';
    if (!lastToday || lastToday.type === 'cikis') {
      nextType = 'giris';
    } else {
      nextType = 'cikis';
    }

    const { error: insErr } = await admin.from('qr_records').insert({
      personel_id: personel.id,
      device_id: personel.device_id,
      type: nextType,
      qr_token,
      location: departman.name,
      latitude: lat,
      longitude: lng,
      departman_id: departman.id,
    });

    if (insErr) {
      console.error('qr_records insert', insErr);
      return new Response(JSON.stringify({ ok: false, message: insErr.message || 'Kayıt oluşturulamadı.' }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    return new Response(
      JSON.stringify({
        ok: true,
        type: nextType,
        message: nextType === 'giris' ? 'Giriş başarılı' : 'Çıkış başarılı',
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e);
    console.error(e);
    return new Response(JSON.stringify({ ok: false, message: `Sunucu hatası: ${errMsg}` }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
