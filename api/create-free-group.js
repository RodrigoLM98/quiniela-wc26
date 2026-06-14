const { createClient } = require('@supabase/supabase-js');

const ALLOWED_ORIGIN = 'https://www.wc26pool.com';

function generateCode() {
  return Math.random().toString(36).substr(2, 8).toUpperCase();
}

module.exports = async (req, res) => {
  const origin = req.headers.origin || '';
  if (origin === ALLOWED_ORIGIN) {
    res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Vary', 'Origin');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Rechazar peticiones de orígenes no permitidos
  if (origin && origin !== ALLOWED_ORIGIN) {
    return res.status(403).json({ error: 'Origen no permitido.' });
  }

  const { groupName, userId, promoCode } = req.body || {};
  if (!groupName || !userId) {
    return res.status(400).json({ error: 'Faltan campos requeridos' });
  }

  if (!process.env.PROMO_CODE || promoCode !== process.env.PROMO_CODE) {
    return res.status(403).json({ error: 'Código promocional inválido.' });
  }

  try {
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY
    );

    let inviteCode = generateCode();
    for (let i = 0; i < 10; i++) {
      const { data: taken } = await supabase
        .from('groups').select('id').eq('invite_code', inviteCode).maybeSingle();
      if (!taken) break;
      inviteCode = generateCode();
    }

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
