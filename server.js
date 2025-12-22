// server.js（追記版）

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import Stripe from 'stripe';

const app = express();
const PORT = process.env.PORT || 3000;
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// --- Webhook（既存。先頭で raw を使う） ---
app.post('/webhooks/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const sig = req.headers['stripe-signature'];
    const event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );

    switch (event.type) {
      case 'checkout.session.completed': {
        const s = event.data.object;
        console.log('[Webhook] PAID order =', s.client_reference_id);
        // ここで受注確定など（必要ならDB更新）
        break;
      }
      case 'checkout.session.expired': {
        const s = event.data.object;
        console.log('[Webhook] EXPIRED order =', s.client_reference_id);
        break;
      }
      default: break;
    }
    res.json({ received: true });
  } catch (err) {
    console.error('[Webhook Error]', err.message);
    res.status(400).send(`Webhook Error: ${err.message}`);
  }
});

// --- ここから通常の JSON API ---
app.use(cors());            // ← ブラウザから叩くなら付ける
app.use(express.json());

app.get('/health', (_req, res) => res.send('ok'));

// 成功ページからの照会（既存）
app.get('/api/checkout-status', async (req, res) => {
  try {
    const { cs } = req.query; // 例: cs_test_xxx
    if (!cs) return res.status(400).json({ ok:false, error:'MISSING_CS' });
    const s = await stripe.checkout.sessions.retrieve(cs, { expand: ['payment_intent'] });
    res.json({
      ok: true,
      orderId: s.client_reference_id,
      amount: s.amount_total,
      currency: s.currency,
      payment_status: s.payment_status,
      status: s.status,
    });
  } catch (e) {
    console.error('[checkout-status]', e);
    res.status(400).json({ ok:false, error: e.message });
  }
});

/** 追加：Twilio を使わず、Checkout URL を返す最小API */
app.post('/api/create-checkout', async (req, res) => {
  try {
    const { orderId, amountJpy } = req.body;
    if (!orderId || !Number.isInteger(amountJpy) || amountJpy <= 0) {
      return res.status(400).json({ ok:false, error:'BAD_INPUT' });
    }
    const appBase = process.env.APP_BASE_URL; // 例: https://lovework.jp

    const params = {
      mode: 'payment',
      line_items: [{
        price_data: {
          currency: 'jpy',
          product_data: { name: `Order #${orderId}` },
          unit_amount: amountJpy,         // JPY は 0 小数
        },
        quantity: 1,
      }],
      success_url: `${appBase}/payment/success?order=${encodeURIComponent(orderId)}&cs={CHECKOUT_SESSION_ID}`,
      cancel_url:  `${appBase}/payment/cancel?order=${encodeURIComponent(orderId)}`,
      client_reference_id: String(orderId),
      expires_at: Math.floor(Date.now()/1000) + 60 * 60 * 24, // 24h
    };

    const session = await stripe.checkout.sessions.create(params, {
      idempotencyKey: `order-${orderId}`, // 二重発行対策
    });

    res.json({ ok:true, url: session.url, sessionId: session.id });
  } catch (e) {
    console.error('[create-checkout]', e);
    res.status(400).json({ ok:false, error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
