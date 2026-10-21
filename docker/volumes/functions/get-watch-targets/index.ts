// @ts-nocheck
// Supabase Edge (Deno). Expo TS / URL import / Deno.serve burada denetlenmez.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.8';

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

  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return jsonResponse({ ok: false, message: 'Oturum bulunamadı.' });
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
      .select('id')
      .eq('auth_user_id', user.id)
      .maybeSingle();

    if (callerErr || !caller) {
      return jsonResponse({ ok: false, message: 'Personel bulunamadı.' });
    }

    const { data: targets, error: targetsErr } = await admin
      .from('watch_targets')
      .select('id, latitude, longitude, radius')
      .eq('personel_id', caller.id)
      .eq('is_active', true);

    if (targetsErr) {
      return jsonResponse({ ok: false, message: 'Watch hedefleri okunamadı: ' + targetsErr.message });
    }

    return jsonResponse({ ok: true, targets: targets ?? [] });
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e);
    console.error(e);
    return jsonResponse({ ok: false, message: `Sunucu hatası: ${errMsg}` });
  }
});
