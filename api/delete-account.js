const { createClient } = require('@supabase/supabase-js');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { accessToken } = req.body || {};
  if (!accessToken) return res.status(400).json({ error: 'Falta el token de sesión.' });

  try {
    const admin = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY
    );

    // Verificar identidad con el token del propio usuario (no se confía en un userId del body)
    const { data: { user }, error: authErr } = await admin.auth.getUser(accessToken);
    if (authErr || !user) {
      return res.status(401).json({ error: 'Sesión inválida.' });
    }
    const uid = user.id;

    // Borrar datos en orden seguro:
    // 1) Grupos que creó (cascada borra sus group_members)
    await admin.from('groups').delete().eq('owner_id', uid);
    // 2) Sus picks y predicciones
    await admin.from('picks').delete().eq('user_id', uid);
    await admin.from('predictions').delete().eq('user_id', uid);
    // 3) Sus membresías en grupos de otros
    await admin.from('group_members').delete().eq('user_id', uid);
    // 4) Su perfil
    await admin.from('profiles').delete().eq('id', uid);
    // 5) Su cuenta de autenticación
    const { error: delErr } = await admin.auth.admin.deleteUser(uid);
    if (delErr) throw delErr;

    res.json({ success: true });
  } catch (err) {
    console.error('delete-account error:', err.message);
    res.status(500).json({ error: err.message });
  }
};
