// server.js
// .env を必ず一番最初に読む
import 'dotenv/config';

import express from 'express';
import Stripe from 'stripe';

const app = express();
const PORT = process.env.PORT || 3000;

// ───────────────────────────────
// WooCommerce REST helpers
// ───────────────────────────────
function mustEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
}
const WC_BASE_URL = mustEnv('WC_BASE_URL');               // 例: https://lovework.jp
const WC_CK       = mustEnv('WC_CONSUMER_KEY');           // Woo API Key (Read/Write)
const WC_CS       = mustEnv('WC_CONSUMER_SECRET');

function wcUrl(path) {
  const u = new URL(`${WC_BASE_URL.replace(/\/$/, '')}/wp-json/wc/v3${path}`);
  u.searchParams.set('consumer_key', WC_CK);
  u.searchParams.set('consumer_secret', WC_CS);
  return u.toString();
}

async function wcGetOrder(orderId) {
  const r = await fetch(wcUrl(`/orders/${orderId}`));
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`Woo GET ${orderId} failed: ${r.status} ${t.slice(0,400)}`);
  }
  return r.json();
}

async function wcUpdateOrderStatus(orderId, status) {
  const r = await fetch(wcUrl(`/orders/${orderId}`), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status }),
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`Woo PUT ${orderId} failed: ${r.status} ${t.slice(0,400)}`);
  }
  return r.json();
}

// ───────────────────────────────
// Stripe SDK（Webhook検証にも使う）
// ───────────────────────────────
const stripe = new Stripe(mustEnv('STRIPE_SECRET_KEY'));

// 1) Webhook（raw で最初に登録するのが超重要）
app.post(
  '/webhooks/stripe',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    try {
      const sig = req.headers['stripe-signature'];
      const event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        mustEnv('STRIPE_WEBHOOK_SECRET')
      );

      switch (event.type) {
        case 'checkout.session.completed': {
          const session = event.data.object;
          const orderId = parseInt(session.client_reference_id, 10);

          // 念のためのガード
          if (!orderId) break;
          if (session.mode !== 'payment') break;
          if (session.payment_status !== 'paid') break;

          // Woo を processing に更新（すでに processing/completed なら何もしない）
          try {
            const cur = await wcGetOrder(orderId);
            const s = String(cur.status || '');
            if (s !== 'processing' && s !== 'completed') {
              await wcUpdateOrderStatus(orderId, 'processing');
              console.log(`[Webhook] order ${orderId} -> processing`);
            } else {
              console.log(`[Webhook] order ${orderId} already ${s}`);
            }
          } catch (e) {
            // 401 の場合は CK/CS or WAF/ベーシック認証が原因のことが多い
            console.error('[Webhook Error] Woo update failed:', e.message);
            // Stripe は 2xx 以外だとリトライしてくれる。Woo 側一時不調なら 500 を返して再試行させるのも手。
            return res.status(500).send('Woo update failed');
          }
          break;
        }

        case 'checkout.session.expired': {
          const s = event.data.object;
          console.log('[Webhook] expired order:', s.client_reference_id);
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
  }
);

// 2) ここから下は JSON でOK（Webhookより下に置く）
app.use(express.json());

app.get('/health', (_req, res) => res.send('ok'));

// 3) 注文直後に WP → Render が叩くエンドポイント（リダイレクト先の Stripe URL を作る）
app.post('/api/create-checkout', async (req, res) => {
  try {
    // 内部APIキーで保護（mu-plugin から X-API-KEY を付与）
    const apiKey = req.header('X-API-KEY');
    if (!apiKey || apiKey !== mustEnv('INTERNAL_API_KEY')) {
      return res.status(401).json({ ok:false, error:'UNAUTHORIZED' });
    }

    const { orderId, amountJpy } = req.body || {};
    if (!Number.isInteger(orderId) || orderId <= 0) {
      return res.status(400).json({ ok:false, error:'INVALID_ORDER_ID' });
    }
    if (!Number.isInteger(amountJpy) || amountJpy <= 0) {
      return res.status(400).json({ ok:false, error:'INVALID_AMOUNT_JPY_INTEGER_REQUIRED' });
    }

    const appBase = mustEnv('APP_BASE_URL');

    const params = {
      mode: 'payment',
      line_items: [{
        price_data: {
          currency: 'jpy',
          product_data: { name: `Order #${orderId}` },
          unit_amount: amountJpy,
        },
        quantity: 1,
      }],
      success_url: `${appBase}/payment/success?order=${encodeURIComponent(orderId)}&cs={CHECKOUT_SESSION_ID}`,
      cancel_url:  `${appBase}/payment/cancel?order=${encodeURIComponent(orderId)}`,
      client_reference_id: String(orderId),
      // 24h 有効
      expires_at: Math.floor(Date.now()/1000) + 60*60*24
    };

    // idempotency: 同一 orderId では 1 セッションだけ（何回叩かれても同一判定）
    const session = await stripe.checkout.sessions.create(params, {
      idempotencyKey: `order-${orderId}`,
    });

    res.json({ ok:true, url: session.url, sessionId: session.id });
  } catch (e) {
    console.error('[create-checkout] error', e);
    res.status(400).json({ ok:false, error:e.message || 'FAILED' });
  }
});

// （任意）成功ページから決済ステータスを照会したい場合
app.get('/api/checkout-status', async (req, res) => {
  try {
    const { cs } = req.query;
    if (!cs) return res.status(400).json({ ok:false, error:'MISSING_CS' });

    const session = await stripe.checkout.sessions.retrieve(cs, {
      expand: ['payment_intent'],
    });

    res.json({
      ok: true,
      orderId: session.client_reference_id,
      amount: session.amount_total,
      currency: session.currency,
      payment_status: session.payment_status,
      status: session.status,
    });
  } catch (e) {
    console.error('[checkout-status]', e);
    res.status(400).json({ ok:false, error:e.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
