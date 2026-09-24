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

// Base de données temporaire en mémoire
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
    console.error('Erreur enregistrement terminal:', error);
    return res.status(500).json({ error: error.raw ? error.raw.message : error.message });
  }
});

// -----------------------------------------------------------------------------
// 2. ROUTE : Vérifier le statut du compte (GET - Utilisé par JavaFX Polling)
// -----------------------------------------------------------------------------
app.get('/v1/stripe/account-status', async (req, res) => {
  try {
    const { merchantId } = req.query;

    if (!merchantId) {
      return res.status(400).json({ error: 'Le paramètre merchantId est requis.' });
    }

    const merchant = merchantsDB[merchantId];

    if (!merchant || !merchant.stripeAccountId) {
      return res.json({
        stripe_account_id: null,
        details_submitted: false,
        charges_enabled: false
      });
    }

    const account = await stripe.accounts.retrieve(merchant.stripeAccountId);

    merchant.details_submitted = account.details_submitted;
    merchant.charges_enabled = account.charges_enabled;

    return res.json({
      stripe_account_id: account.id,
      details_submitted: account.details_submitted,
      charges_enabled: account.charges_enabled
    });

  } catch (error) {
   console.error('Erreur enregistrement terminal:', error);
    return res.status(500).json({ error: error.raw ? error.raw.message : error.message });
  }
});

// -----------------------------------------------------------------------------
// 3. ROUTE : Récupérer les lecteurs actifs sur un emplacement (GET)
// -----------------------------------------------------------------------------
app.get('/v1/stripe/terminal/readers', async (req, res) => {
  try {
    const { locationId } = req.query;

    if (!locationId) {
      return res.status(400).json({ error: 'Le paramètre locationId est obligatoire.' });
    }

    const readers = await stripe.terminal.readers.list({
      location: locationId,
      status: 'online'
    });

    return res.json(readers.data);

  } catch (error) {
    console.error('Erreur enregistrement terminal:', error);
    return res.status(500).json({ error: error.raw ? error.raw.message : error.message });
  }
}); // <-- L'ACCOLADE ET LA PARENTHÈSE ÉTAIENT MANQUANTES ICI

// -----------------------------------------------------------------------------
// 4. ROUTE DYNAMIQUE : Enregistrer un terminal avec adresse dynamique (POST)
// -----------------------------------------------------------------------------
app.post('/v1/stripe/terminal/register-reader', async (req, res) => {
  try {
    const { registrationCode, storeCode, label, address } = req.body;

    if (!registrationCode || !storeCode) {
      return res.status(400).json({ error: 'Le code à 3 mots et le code magasin (storeCode) sont requis.' });
    }

    // 1. Chercher si un emplacement Stripe existe déjà pour ce storeCode
    const existingLocations = await stripe.terminal.locations.list({ limit: 100 });
    let location = existingLocations.data.find(
      loc => loc.metadata && loc.metadata.lintor_store_code === storeCode
    );
    // 2. Créer l'emplacement automatiquement s'il n'existe pas
    if (!location) {
      location = await stripe.terminal.locations.create({
        display_name: `Magasin ${storeCode}`,
        address: {
          line1: address?.line1 || '3925, rue Merckell',
          city: address?.city || 'Laval',
          state: address?.state || 'QC',
          country: address?.country || 'CA',
          postal_code: address?.postalCode || 'H7C 2T9'
        },
        metadata: {
          lintor_store_code: storeCode
        }
      });
    }
       // 3. Enregistrer le lecteur sur cet emplacement Stripe
    const reader = await stripe.terminal.readers.create({
      registration_code: registrationCode,
      label: label || `Caisse ${storeCode}`,
      location: location.id,
      metadata: {
        lintor_store_code: storeCode
      }
    });

    // 4. Renvoi de la réponse JSON au client JavaFX
    return res.json({
      success: true,
      storeCode: storeCode,
      locationId: location.id,
      readerId: reader.id,
      label: reader.label
    });

  } catch (error) {
    console.error('Erreur enregistrement terminal:', error);
    return res.status(500).json({ error: error.raw ? error.raw.message : error.message });
  }
});

// -----------------------------------------------------------------------------
// 5. ROUTE : Webhook Stripe (POST - Notification automatique)
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

  if (event.type === 'account.updated') {
    const account = event.data.object;
    const merchantId = account.metadata?.merchantId;

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
