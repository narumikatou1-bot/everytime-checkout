// server.js
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import Stripe from 'stripe';

const app = express();
const PORT = process.env.PORT || 3000;
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// --- Stripe Webhook（raw が必須なので一番上で定義）---
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
        // ここでDB更新・通知など（今回はWooCommerceなし）
        break;
      }
      case 'checkout.session.expired': {
        const s = event.data.object;
        console.log('[Webhook] EXPIRED order =', s.client_reference_id);
        break;
      }
      default:
        break;
    }
    res.json({ received: true });
  } catch (err) {
    console.error('[Webhook Error]', err.message);
    res.status(400).send(`Webhook Error: ${err.message}`);
  }
});

// --- JSON/CORS は Webhook の後で ---
app.use(cors({ origin: ['https://lovework.jp', 'http://localhost:5173'], methods: ['GET','POST'] }));
app.use(express.json());

app.get('/health', (_req, res) => res.send('ok'));

// 成功ページ等から使えるステータス照会
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
      payment_status: s.payment_status, // 'paid' | 'unpaid'
      status: s.status                  // 'complete' | 'open' | 'expired'
    });
  } catch (e) {
    console.error('[checkout-status]', e);
    res.status(400).json({ ok:false, error:e.message });
  }
});

// フロントから呼ぶ：決済URLを発行して返す（Twilioなし）
app.post('/api/orders/:orderId/link', async (req, res) => {
  try {
    const { orderId } = req.params;
    const { amountJpy } = req.body; // 例: { "amountJpy": 5980 }
    if (!Number.isInteger(amountJpy) || amountJpy <= 0) {
      return res.status(400).json({ ok:false, error:'INVALID_AMOUNT_JPY_INTEGER_REQUIRED' });
    }

    const appBase = process.env.APP_BASE_URL;
    const params = {
      mode: 'payment',
      line_items: [{
        price_data: {
          currency: 'jpy',
          product_data: { name: `Order #${orderId}` },
          unit_amount: amountJpy, // JPYは0小数
        },
        quantity: 1,
      }],
      success_url: `${appBase}/payment/success?order=${encodeURIComponent(orderId)}&cs={CHECKOUT_SESSION_ID}`,
      cancel_url : `${appBase}/payment/cancel?order=${encodeURIComponent(orderId)}`,
      client_reference_id: String(orderId),
      // 有効期限を24hにしたい場合
      // expires_at: Math.floor(Date.now()/1000) + 60*60*24,
    };

    const session = await stripe.checkout.sessions.create(params, {
      idempotencyKey: `order-${orderId}`, // 二重発行対策
    });

    res.json({ ok:true, url: session.url, sessionId: session.id });
  } catch (e) {
    console.error('[create-link]', e);
    res.status(400).json({ ok:false, error: e.message || 'FAILED' });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});