// @ts-nocheck
// Supabase Edge (Deno). Expo TS / URL import / Deno.serve burada denetlenmez.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.8';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

/** Oturumsuz yazılabilen action'lar (mobil kanıt logları) */
const ANON_AUTH_ACTIONS = new Set([
  'login.fail',
  'auth.password_recovery_otp',
  'auth.password_change',
  'personel.device_mismatch',
]);

function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
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
    return jsonResponse({ ok: false, message: 'Edge ortam değişkenleri eksik.' });
  }

  if (req.method !== 'POST') {
    return jsonResponse({ ok: false, message: 'Method not allowed' });
  }

  try {
    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      return jsonResponse({ ok: false, message: 'Geçersiz istek gövdesi.' });
    }

    const action = String(body.action ?? '').trim();
    const summary = String(body.summary ?? '').trim();
    if (!action || !summary) {
      return jsonResponse({ ok: false, message: 'action ve summary gerekli.' });
    }

    const metadata =
      typeof body.metadata === 'object' && body.metadata !== null
        ? (body.metadata as Record<string, unknown>)
        : {};

    const actorEmail =
      typeof body.actor_email === 'string' && body.actor_email.trim()
        ? body.actor_email.trim()
        : null;
    const actorName =
      typeof body.actor_name === 'string' && body.actor_name.trim()
        ? body.actor_name.trim()
        : null;
    const entityType =
      typeof body.entity_type === 'string' ? body.entity_type : null;
    const entityId =
      body.entity_id != null ? String(body.entity_id) : null;

    const authHeader = req.headers.get('Authorization');
    const hasBearer = Boolean(authHeader?.replace(/^Bearer\s+/i, '').trim());

    const admin = createClient(supabaseUrl, serviceKey);

    if (!hasBearer) {
      if (!ANON_AUTH_ACTIONS.has(action)) {
        return jsonResponse({ ok: false, message: 'Yetkilendirme gerekli.' }, 401);
      }

      const { error } = await admin.from('activity_logs').insert([
        {
          actor_personel_id: null,
          actor_auth_user_id: null,
          actor_name: actorName,
          actor_email: actorEmail,
          actor_role: null,
          action,
          entity_type: entityType,
          entity_id: entityId,
          summary,
          metadata,
          source: 'mobile',
        },
      ]);

      if (error) {
        console.error('activity_logs anon insert:', error.message);
        return jsonResponse({ ok: false, message: error.message });
      }
      return jsonResponse({ ok: true });
    }

    const userClient = createClient(supabaseUrl, supabaseAnon, {
      global: { headers: { Authorization: authHeader } },
    });
    const {
      data: { user },
      error: userErr,
    } = await userClient.auth.getUser();

    if (userErr || !user?.id) {
      if (ANON_AUTH_ACTIONS.has(action)) {
        const { error } = await admin.from('activity_logs').insert([
          {
            actor_personel_id: null,
            actor_auth_user_id: null,
            actor_name: actorName,
            actor_email: actorEmail,
            actor_role: null,
            action,
            entity_type: entityType,
            entity_id: entityId,
            summary,
            metadata,
            source: 'mobile',
          },
        ]);
        if (error) {
          return jsonResponse({ ok: false, message: error.message });
        }
        return jsonResponse({ ok: true });
      }
      return jsonResponse({ ok: false, message: 'Oturum doğrulanamadı.' }, 401);
    }

    const { data: personel } = await admin
      .from('personeller')
      .select('id, name, email, role')
      .eq('auth_user_id', user.id)
      .maybeSingle();

    const bodyPersonelId =
      typeof body.actor_personel_id === 'string' ? body.actor_personel_id : null;

    const { error } = await admin.from('activity_logs').insert([
      {
        actor_personel_id: personel?.id ?? bodyPersonelId,
        actor_auth_user_id: user.id,
        actor_name: personel?.name ?? actorName,
        actor_email: personel?.email ?? actorEmail,
        actor_role: personel?.role ?? (typeof body.actor_role === 'string' ? body.actor_role : null),
        action,
        entity_type: entityType,
        entity_id: entityId,
        summary,
        metadata,
        source: 'mobile',
      },
    ]);

    if (error) {
      console.error('activity_logs auth insert:', error.message);
      return jsonResponse({ ok: false, message: error.message });
    }

    return jsonResponse({ ok: true });
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e);
    console.error(e);
    return jsonResponse({ ok: false, message: `Sunucu hatası: ${errMsg}` });
  }
});
