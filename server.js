// server.js  — 完全版（WP→Render→Stripe リダイレクト / WebhookでWoo注文を自動更新）

// 1) .env を最初にロード（超重要）
import 'dotenv/config';

import express from 'express';
import Stripe from 'stripe';

const app  = express();
const PORT = process.env.PORT || 3000;

// ---- Stripe SDK（Webhook 検証や照会でも使う）----
const stripe = new Stripe(requiredEnv('STRIPE_SECRET_KEY'));

/* =========================
 *  WooCommerce REST helpers
 * ========================= */
function requiredEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
}
const WC_BASE_URL = requiredEnv('WC_BASE_URL');
const WC_CK       = requiredEnv('WC_CONSUMER_KEY');
const WC_CS       = requiredEnv('WC_CONSUMER_SECRET');

// /wp-json/wc/v3 へ ck/cs をクエリに付けて叩く（HTTPS前提）
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
    throw new Error(`Woo GET ${orderId} failed: ${r.status} ${t.slice(0, 200)}`);
  }
  return r.json();
}
async function wcUpdateOrderStatus(orderId, status) {
  const r = await fetch(wcUrl(`/orders/${orderId}`), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body   : JSON.stringify({ status }),
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`Woo PUT ${orderId} failed: ${r.status} ${t.slice(0, 200)}`);
  }
  return r.json();
}

/* ========================================================
 *  Webhook（※ raw body が必須）— JSON パーサより前に置く
 * ======================================================== */
app.post(
  '/webhooks/stripe',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    try {
      const sig = req.headers['stripe-signature'];
      const event = stripe.webhooks.constructEvent(
        req.body,                               // ← raw body
        sig,
        requiredEnv('STRIPE_WEBHOOK_SECRET')    // VAPESIGN の送信先の Signing secret
      );

      switch (event.type) {
        case 'checkout.session.completed': {
          // 1) 成功のみを採用
          const s = event.data.object;
          const orderId = parseInt(s.client_reference_id, 10);

          if (!orderId) break;
          if (s.mode !== 'payment') break;
          if (s.payment_status !== 'paid') break;

          // 2) べき等：既に処理済みなら何もしない
          const cur = await wcGetOrder(orderId);
          const curStatus = String(cur.status || '');

          if (curStatus === 'processing' || curStatus === 'completed') {
            console.log(`[Webhook] order ${orderId} already ${curStatus}`);
          } else {
            await wcUpdateOrderStatus(orderId, 'processing');
            console.log(`[Webhook] order ${orderId} -> processing`);
          }
          break;
        }

        case 'checkout.session.expired': {
          // 期限切れ（必要なら在庫解放など）
          const s = event.data.object;
          console.log('[Webhook] expired order:', s.client_reference_id);
          break;
        }

        default:
          // 必要に応じて他イベントも追加
          break;
      }

      res.json({ received: true });
    } catch (err) {
      // 500 を返すと Stripe がリトライしてくれる（恒久エラーは 400）
      console.error('[Webhook Error]', err);
      const code = String(err?.message || '').includes('No signatures found') ? 400 : 500;
      return res.status(code).send(`Webhook Error: ${err.message}`);
    }
  }
);

/* ======================================================
 *  ここから通常の JSON ルート（Webhook より後に置く）
 * ====================================================== */
app.use(express.json());

// 健康診断
app.get('/health', (_req, res) => res.send('ok'));

// 管理・デバッグ用: Checkout セッション照会
app.get('/api/checkout-status', async (req, res) => {
  try {
    const { cs } = req.query; // 例: cs_live_***
    if (!cs) return res.status(400).json({ ok: false, error: 'MISSING_CS' });

    const s = await stripe.checkout.sessions.retrieve(String(cs), {
      expand: ['payment_intent'],
    });

    res.json({
      ok            : true,
      orderId       : s.client_reference_id,
      amount        : s.amount_total,
      currency      : s.currency,
      payment_status: s.payment_status, // 'paid' | 'unpaid' | 'no_payment_required'
      status        : s.status,         // 'complete' | 'open' | 'expired'
    });
  } catch (e) {
    console.error('[checkout-status]', e);
    res.status(400).json({ ok: false, error: e.message });
  }
});

/**
 * 受注直後に WP から内部コールするエンドポイント
 * - リクエスト: { orderId: number, amountJpy: number }
 * - レスポンス: { ok:true, url:string, sessionId:string }
 * 
 * 認証: ヘッダ 'X-API-KEY: <INTERNAL_API_KEY>'
 */
app.post('/api/create-checkout', async (req, res) => {
  try {
    const key = req.headers['x-api-key'];
    if (!key || key !== requiredEnv('INTERNAL_API_KEY')) {
      return res.status(401).json({ ok: false, error: 'UNAUTHORIZED' });
    }

    const { orderId, amountJpy } = req.body || {};
    const id = parseInt(orderId, 10);

    if (!id || !Number.isInteger(id)) {
      return res.status(400).json({ ok: false, error: 'INVALID_ORDER_ID' });
    }
    if (!Number.isInteger(amountJpy) || amountJpy <= 0) {
      return res.status(400).json({ ok: false, error: 'INVALID_AMOUNT_JPY_INTEGER_REQUIRED' });
    }

    const appBase = requiredEnv('APP_BASE_URL');

    // Stripe Checkout セッション作成
    const params = {
      mode: 'payment',
      line_items: [{
        price_data: {
          currency: 'jpy',
          product_data: { name: `Order #${id}` },
          unit_amount: amountJpy, // JPY は 0 小数
        },
        quantity: 1,
      }],
      success_url: `${appBase}/payment/success?order=${encodeURIComponent(id)}&cs={CHECKOUT_SESSION_ID}`,
      cancel_url : `${appBase}/payment/cancel?order=${encodeURIComponent(id)}`,
      client_reference_id: String(id),
    };

    const session = await stripe.checkout.sessions.create(params, {
      idempotencyKey: `order-${id}`, // 二重発行対策
    });

    // フロント（or mu-plugin）側でリダイレクトさせる
    res.json({ ok: true, url: session.url, sessionId: session.id });
  } catch (e) {
    console.error('[create-checkout]', e);
    res.status(400).json({ ok: false, error: e.message || 'FAILED' });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
