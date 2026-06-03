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

  const { groupName, userId, promoCode } = req.body || {};
  if (!groupName || !userId) {
    return res.status(400).json({ error: 'Faltan campos requeridos' });
  }

  // El código secreto vive SOLO en Vercel (env var PROMO_CODE), nunca en el HTML.
  if (!process.env.PROMO_CODE || promoCode !== process.env.PROMO_CODE) {
    return res.status(403).json({ error: 'Código promocional inválido.' });
  }

  try {
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY // Service role: bypass RLS para crear grupo
    );

    // Generar código de invitación único
    let inviteCode = generateCode();
    for (let i = 0; i < 10; i++) {
      const { data: taken } = await supabase
        .from('groups').select('id').eq('invite_code', inviteCode).maybeSingle();
      if (!taken) break;
      inviteCode = generateCode();
    }

    // Crear el grupo (marcado como promo para distinguirlo en la base de datos)
    const { data: group, error: groupErr } = await supabase
      .from('groups')
      .insert({
        name: groupName,
        invite_code: inviteCode,
        owner_id: userId,
        stripe_session_id: 'PROMO',
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
    console.error('create-free-group error:', err.message);
    res.status(500).json({ error: err.message });
  }
};
