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

    // C. Renvoie de l'URL ET du stripe_account_id à JavaFX
    return res.json({
      success: true,
      stripe_account_id: stripeAccountId,
      onboarding_url: accountLink.url
    });

  } catch (error) {
    console.error('Erreur Onboarding Link:', error);
    return res.status(500).json({ error: error.raw ? error.raw.message : error.message });
  }
});

// -----------------------------------------------------------------------------
// 2. ROUTE : Page HTML de confirmation de l'onboarding (GET)
// -----------------------------------------------------------------------------
app.get('/success', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="fr">
    <head>
      <meta charset="UTF-8">
      <title>Configuration LintorPos</title>
      <style>
        body { font-family: Arial, sans-serif; text-align: center; padding-top: 50px; background-color: #f4f6f9; }
        .card { background: white; max-width: 480px; margin: 0 auto; padding: 40px; border-radius: 12px; box-shadow: 0 4px 15px rgba(0,0,0,0.1); }
        h1 { color: #2e7d32; margin-bottom: 10px; }
        p { color: #555; line-height: 1.5; }
      </style>
    </head>
    <body>
      <div class="card">
        <h1>Compte Stripe Connecté !</h1>
        <p>Votre compte a été associé avec succès à LintorPos.</p>
        <p>Vous pouvez maintenant fermer cette fenêtre et continuer dans votre application.</p>
      </div>
    </body>
    </html>
  `);
});

// -----------------------------------------------------------------------------
// 3. ROUTE : Vérifier le statut du compte (GET - Utilisé par JavaFX Polling)
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
    console.error('Erreur Account Status:', error);
    return res.status(500).json({ error: error.raw ? error.raw.message : error.message });
  }
});

// -----------------------------------------------------------------------------
// 4. ROUTE : Récupérer les lecteurs actifs sur un emplacement (GET)
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
    console.error('Erreur Récupération Lecteurs:', error);
    return res.status(500).json({ error: error.raw ? error.raw.message : error.message });
  }
});

// -----------------------------------------------------------------------------
// 5. ROUTE DYNAMIQUE : Enregistrer un terminal avec adresse dynamique (POST)
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
      const rawPostal = address?.postalCode || address?.postal_code || 'H7C 2T9';
      const cleanPostal = rawPostal.toUpperCase().replace(/[^A-Z0-9]/g, '');
      const finalPostalCode = cleanPostal.length === 6 
        ? `${cleanPostal.slice(0, 3)} ${cleanPostal.slice(3)}` 
        : cleanPostal;

      let countryCode = (address?.country || 'CA').toUpperCase().trim();
      if (countryCode.length > 2) {
        countryCode = 'CA';
      }

      location = await stripe.terminal.locations.create({
        display_name: `Magasin ${storeCode}`,
        address: {
          line1: address?.line1 || '3925, rue Merckell',
          city: address?.city || 'Laval',
          state: address?.state || 'QC',
          country: countryCode,
          postal_code: finalPostalCode
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
// 6. ROUTE : Webhook Stripe (POST - Notification automatique)
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

// -----------------------------------------------------------------------------
// 7. ROUTE : Envoyer une transaction de test sur le terminal (POST)
// -----------------------------------------------------------------------------
app.post('/v1/stripe/terminal/process-payment', async (req, res) => {
  try {
    const { readerId, amount, currency } = req.body;

    if (!readerId || !amount) {
      return res.status(400).json({ error: 'Le readerId et le montant (amount) sont requis.' });
    }

    const paymentIntent = await stripe.paymentIntents.create({
      amount: parseInt(amount, 10),
      currency: currency || 'cad',
      payment_method_types: ['card_present'],
      capture_method: 'automatic'
    });

    const reader = await stripe.terminal.readers.processPaymentIntent(readerId, {
      payment_intent: paymentIntent.id
    });

    return res.json({
      success: true,
      readerId: reader.id,
      paymentIntentId: paymentIntent.id,
      status: reader.action ? reader.action.status : 'in_progress'
    });

  } catch (error) {
    console.error('Erreur traitement paiement terminal:', error);
    return res.status(500).json({ error: error.raw ? error.raw.message : error.message });
  }
});

// Démarrage du serveur
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Serveur Backend LintorPos démarré sur le port ${PORT}`);
});
