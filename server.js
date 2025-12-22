// server.js
import 'dotenv/config';
import express from 'express';
import Stripe from 'stripe';

const app = express();
const PORT = process.env.PORT || 3000;

// --- Stripe ---
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// --- WooCommerce REST helpers ---
function mustEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
}
const WC_BASE_URL = mustEnv('WC_BASE_URL');
const WC_CK = mustEnv('WC_CONSUMER_KEY');
const WC_CS = mustEnv('WC_CONSUMER_SECRET');

// /wp-json/wc/v3 のURLを作る（ck/csはクエリで付与）
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
    throw new Error(`Woo GET ${orderId} failed: ${r.status} ${t.slice(0,200)}`);
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
    throw new Error(`Woo PUT ${orderId} failed: ${r.status} ${t.slice(0,200)}`);
  }
  return r.json();
}

/* ---------------- Stripe Webhook（最初に raw で定義） ---------------- */
app.post(
  '/webhooks/stripe',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    try {
      const sig = req.headers['stripe-signature'];
      const event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET
      );

      switch (event.type) {
        case 'checkout.session.completed': {
          const session = event.data.object;
          // セッションをより厳密にチェック（任意）
          if (session.mode !== 'payment') break;
          if (session.payment_status !== 'paid') break;

          // WP 側の注文ID を Checkout 作成時に入れた client_reference_id から取得
          const orderId = parseInt(session.client_reference_id, 10);
          if (!orderId) break;

          // 冪等: すでに更新済みなら何もしない
          const current = await wcGetOrder(orderId);
          const curStatus = String(current.status || '');
          if (curStatus === 'processing' || curStatus === 'completed') {
            console.log(`[Webhook] order ${orderId} already ${curStatus}`);
          } else {
            await wcUpdateOrderStatus(orderId, 'processing');
            console.log(`[Webhook] order ${orderId} -> processing`);
          }
          break;
        }

        case 'checkout.session.expired': {
          const s = event.data.object;
          console.log('[Webhook] expired order:', s.client_reference_id);
          // 必要なら 在庫解放/キャンセル等をここで
          break;
        }

        default:
          // 他のイベントは必要に応じて対応
          break;
      }

      res.json({ received: true });
    } catch (err) {
      // エラー時に 500 を返すと Stripe が自動リトライしてくれる
      console.error('[Webhook Error]', err);
      return res.status(500).send(`Webhook Error: ${err.message}`);
    }
  }
);

/* ---------------- 通常の JSON API は Webhook より下 ---------------- */
app.use(express.json());

// 健康チェック
app.get('/health', (_req, res) => res.send('ok'));

// （任意）決済ステータス照会APIなど、既存のエンドポイントはこのまま
// ・・・あなたの既存コード・・・
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
