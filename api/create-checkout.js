const Stripe = require('stripe');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { groupName, userId } = req.body;
  if (!groupName || !userId) {
    return res.status(400).json({ error: 'Faltan campos requeridos' });
  }

  try {
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'mxn',
          product_data: {
            name: `Quiniela WC26 — Grupo "${groupName}"`,
            description: 'Acceso a la quiniela del Mundial 2026. Los miembros se unen gratis con el código de invitación.',
          },
          unit_amount: 14900, // $149 MXN en centavos
        },
        quantity: 1,
      }],
      mode: 'payment',
      metadata: { groupName, userId },
      success_url: `${process.env.SITE_URL}?payment=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.SITE_URL}?payment=cancelled`,
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('Stripe error:', err.message);
    res.status(500).json({ error: err.message });
  }
};
