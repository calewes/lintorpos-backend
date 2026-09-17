require('dotenv').config();
const express = require('express');
const cors = require('cors');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const app = express();

// Middleware pour analyser le JSON (sauf pour le webhook qui nécessite le corps brut)
app.use((req, res, next) => {
  if (req.originalUrl === '/v1/stripe/webhook') {
    next();
  } else {
    express.json()(req, res, next);
  }
});

app.use(cors());

// Base de données temporaire en mémoire (À remplacer par votre BDD SQLite/PostgreSQL)
const merchantsDB = {};

// -----------------------------------------------------------------------------
// 1. ROUTE : Générer le lien d'onboarding Stripe Connect (POST)
// -----------------------------------------------------------------------------
app.post('/v1/stripe/onboarding-link', async (req, res) => {
  try {
    const { merchantId } = req.query; // Ex: LTR-2026-EBB4F

    if (!merchantId) {
      return res.status(400).json({ error: 'merchantId est requis' });
    }

    let stripeAccountId = merchantsDB[merchantId]?.stripeAccountId;

    // A. Si le marchand n'a pas encore d'ID Stripe, on en crée un nouveau
    if (!stripeAccountId) {
      const account = await stripe.accounts.create({
        type: 'standard',
        metadata: { merchantId: merchantId }
      });
      stripeAccountId = account.id;

      // Sauvegarde temporaire en mémoire
      merchantsDB[merchantId] = {
        stripeAccountId: stripeAccountId,
        details_submitted: false,
        charges_enabled: false
      };
    }

    // B. Créer le lien d'inscription unique (AccountLink)
    const accountLink = await stripe.accountLinks.create({
      account: stripeAccountId,
      refresh_url: `https://api.lintorpos.com/reconnect?merchantId=${merchantId}`,
      return_url: `https://api.lintorpos.com/success?merchantId=${merchantId}`,
      type: 'account_onboarding',
    });

    res.json({ onboarding_url: accountLink.url });

  } catch (error) {
    console.error('Erreur Onboarding:', error);
    res.status(500).json({ error: error.message });
  }
});

// -----------------------------------------------------------------------------
// 2. ROUTE : Vérifier le statut du compte (GET - Utilisé par JavaFX Polling)
// -----------------------------------------------------------------------------
app.get('/v1/stripe/account-status', async (req, res) => {
  try {
    const { merchantId } = req.query;
    const merchant = merchantsDB[merchantId];

    if (!merchant) {
      return res.json({ details_submitted: false, charges_enabled: false });
    }

    // Interroger directement Stripe pour vérifier l'état à jour
    const account = await stripe.accounts.retrieve(merchant.stripeAccountId);

    // Mettre à jour notre mémoire locale
    merchant.details_submitted = account.details_submitted;
    merchant.charges_enabled = account.charges_enabled;

    res.json({
      stripe_account_id: account.id,
      details_submitted: account.details_submitted,
      charges_enabled: account.charges_enabled
    });

  } catch (error) {
    console.error('Erreur Vérification Statut:', error);
    res.status(500).json({ error: error.message });
  }
});

// -----------------------------------------------------------------------------
// 3. ROUTE : Webhook Stripe (POST - Notification automatique de Stripe)
// -----------------------------------------------------------------------------
app.post('/v1/stripe/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error(`Erreur de signature Webhook: ${err.message}`);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Événement déclenché lorsque le marchand termine la saisie
  if (event.type === 'account.updated') {
    const account = event.data.object;
    const merchantId = account.metadata.merchantId;

    if (merchantId && merchantsDB[merchantId]) {
      merchantsDB[merchantId].details_submitted = account.details_submitted;
      merchantsDB[merchantId].charges_enabled = account.charges_enabled;
      console.log(`[WEBHOOK] Compte marchand ${merchantId} mis à jour. Charges actives : ${account.charges_enabled}`);
    }
  }

  res.json({ received: true });
});

// Démarrage du serveur
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Serveur Backend LintorPos démarré sur le port ${PORT}`);
});