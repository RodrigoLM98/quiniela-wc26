const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');

function generateCode() {
  return Math.random().toString(36).substr(2, 8).toUpperCase();
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { sessionId } = req.body || {};
  if (!sessionId) {
    return res.status(400).json({ error: 'Falta el identificador de la sesión de pago.' });
  }

  try {
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY // Service role: bypass RLS para crear grupo
    );

    // Verificar el pago directamente con Stripe (fuente de verdad)
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    if (session.payment_status !== 'paid') {
      return res.status(400).json({ error: 'El pago no se ha completado.' });
    }

    // Los datos del grupo vienen de los metadatos de Stripe (robusto entre dispositivos).
    // El body es solo respaldo por si los metadatos faltaran.
    const md = session.metadata || {};
    const groupName = md.groupName || (req.body && req.body.groupName);
    const userId = md.userId || (req.body && req.body.userId);
    if (!groupName || !userId) {
      return res.status(400).json({ error: 'No se encontraron los datos del grupo en el pago.' });
    }

    // Idempotencia: si ya se creó el grupo para este session_id, devolverlo
    const { data: existing } = await supabase
      .from('groups')
      .select('*')
      .eq('stripe_session_id', sessionId)
      .maybeSingle();

    if (existing) {
      // Asegurar que el dueño sea miembro (por si la inserción previa falló)
      await supabase.from('group_members')
        .upsert({ group_id: existing.id, user_id: userId }, { onConflict: 'group_id,user_id' });
      return res.json({ group: existing });
    }

    // Generar código único de invitación
    let inviteCode = generateCode();
    for (let i = 0; i < 10; i++) {
      const { data: taken } = await supabase
        .from('groups').select('id').eq('invite_code', inviteCode).maybeSingle();
      if (!taken) break;
      inviteCode = generateCode();
    }

    // Crear el grupo
    const { data: group, error: groupErr } = await supabase
      .from('groups')
      .insert({
        name: groupName,
        invite_code: inviteCode,
        owner_id: userId,
        stripe_session_id: sessionId,
        status: 'active',
      })
      .select()
      .single();

    if (groupErr) throw groupErr;

    // Agregar al dueño como primer miembro
    await supabase.from('group_members').insert({
      group_id: group.id,
      user_id: userId,
    });

    res.json({ group });
  } catch (err) {
    console.error('verify-payment error:', err.message);
    res.status(500).json({ error: err.message });
  }
};
