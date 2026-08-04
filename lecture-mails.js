/* ============================================================
   CDL — Lecteur de boite mail  ·  v3  ·  LECTURE SEULE
   ------------------------------------------------------------
   Nouveau en v3 :
     • reconnaissance de l'expediteur dans la table "dossiers"
       (311 dossiers Lab Event : clients, prospects, perdus)
     • le nom du couple remplace "Clients" / "Prospects"
     • plateformes (Mariages.net, Lab Event) : extraction de
       l'adresse reelle du couple dans le corps du message
     • categorie "technique" separee du demarchage
   Ne supprime, ne deplace et ne modifie JAMAIS un mail.
   ============================================================ */
const { ImapFlow } = require("imapflow");
const { simpleParser } = require("mailparser");
const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const FREQ = Math.max(1, parseInt(process.env.FREQUENCE_MINUTES || "3", 10)) * 60 * 1000;

/* ---------- Annuaire des dossiers ---------- */
let ANNUAIRE = new Map();

async function chargerAnnuaire() {
  const { data, error } = await supabase
    .from("dossiers")
    .select("nom, contact, email, statut, type_client, titre_projet, date_debut")
    .limit(2000);

  if (error) {
    console.log("  ! Annuaire indisponible :", error.message);
    return;
  }

  const rang = { client: 0, prospect: 1, perdu: 2 };
  const map = new Map();
  for (const d of data || []) {
    const cle = (d.email || "").trim().toLowerCase();
    if (!cle) continue;
    const actuel = map.get(cle);
    // on garde le dossier le plus engageant (client > prospect > perdu)
    if (!actuel || rang[d.statut] < rang[actuel.statut]) map.set(cle, d);
  }
  ANNUAIRE = map;
  console.log(`Annuaire charge : ${ANNUAIRE.size} adresses connues.`);
}

/* ---------- Plateformes d'apport d'affaires ---------- */
const PLATEFORMES = ["mariages.net", "mariage.net", "lab-event", "bridebook",
  "zankyou", "1001salles", "abcsalles"];

// Cherche l'adresse du couple dans le corps d'un mail de plateforme
function adresseDansCorps(corps) {
  if (!corps) return null;
  const trouvees = corps.match(/[\w.+-]+@[\w-]+\.[\w.-]+/g) || [];
  const exclus = /mariages?\.net|lab-event|bridebook|zankyou|domainedelacourdeslys|noreply|no-reply|notify|sentry|wixpress/i;
  for (const a of trouvees) {
    const propre = a.toLowerCase().replace(/[.,;)]$/, "");
    if (!exclus.test(propre)) return propre;
  }
  return null;
}

/* ---------- Classement ---------- */
function classer(mail) {
  const de = (mail.expediteur_email || "").toLowerCase();
  const objet = (mail.objet || "").toLowerCase();
  const corps = (mail.corps || mail.extrait || "").toLowerCase();
  const tout = objet + " " + corps;

  const libelle = (d) => {
    const base = d.nom || d.contact || "Dossier";
    return d.date_debut ? `${base} · ${d.date_debut.slice(0, 4)}` : base;
  };

  /* 1. Expediteur connu : la reponse la plus fiable */
  const connu = ANNUAIRE.get(de);
  if (connu) {
    if (connu.statut === "client") {
      return { categorie: "client", dossier: libelle(connu),
        analyse: `Client identifie — ${connu.titre_projet || "dossier en cours"}` };
    }
    if (connu.statut === "prospect") {
      return { categorie: "prospect", dossier: libelle(connu),
        analyse: `Prospect identifie — ${connu.titre_projet || "demande en cours"}` };
    }
    // dossier perdu : il reprend contact, c'est une nouvelle piste
    return { categorie: "prospect", dossier: libelle(connu),
      analyse: "Ancien contact (dossier perdu) qui reecrit — piste a requalifier" };
  }

  /* 2. Plateforme d'apport d'affaires : on cherche le couple derriere */
  if (PLATEFORMES.some((p) => de.includes(p))) {
    const vraie = adresseDansCorps(mail.corps || mail.extrait);
    const suite = vraie && ANNUAIRE.get(vraie);
    if (suite) {
      return { categorie: suite.statut === "client" ? "client" : "prospect",
        dossier: libelle(suite),
        analyse: `Via plateforme — dossier reconnu (${vraie})` };
    }
    return { categorie: "prospect", dossier: "Nouvelle demande",
      analyse: vraie
        ? `Nouvelle demande via plateforme — contact : ${vraie}`
        : "Nouvelle demande via plateforme — a rattacher a un dossier" };
  }

  /* 3. Technique : outils du Domaine */
  const OUTILS = ["render.com", "neon.tech", "supabase", "github", "vercel",
    "cloudflare", "ovh.com", "ovh.net", "anthropic", "claude.ai", "mammotion",
    "3douest", "apple.com", "google.com", "microsoft"];
  const CODES = /code de verification|verification code|2fa|double authentification|reinitialisation|password reset|verify your device|connexion detectee/;
  if (OUTILS.some((m) => de.includes(m)) || CODES.test(tout)) {
    return { categorie: "technique", dossier: null,
      analyse: "Notification technique — aucune action commerciale" };
  }

  /* 4. Demarchage */
  const DEMARCHAGE = ["sistrix", "dolcevita", "dolce-vita", "le-guide", "guinguette",
    "newsletter", "webinar", "mjt.lu", "mailjet", "sendinblue", "brevo",
    "unsubscribe", "desinscri", "votre visibilite", "referencement"];
  if (DEMARCHAGE.some((m) => de.includes(m) || tout.includes(m))) {
    return { categorie: "demarchage", dossier: null,
      analyse: "Sollicitation commerciale externe — sans suite" };
  }

  /* 5. Compta */
  if (/factur|avoir|relev|virement|prelevement|echeance|taxe de sejour|urssaf|impot|tva|comptab|cegestion|declaration|payfip/.test(tout)) {
    return { categorie: "compta", dossier: "Compta",
      analyse: "Piece comptable ou taxe — a rapprocher de l'exercice en cours" };
  }

  /* 6. Document d'organisation */
  if (/rooming|plan de table|deroul|liste des invit|traiteur|photographe|etat des lieux|caution|assurance/.test(tout)) {
    return { categorie: "client", dossier: "A rattacher",
      analyse: "Document d'organisation — expediteur inconnu, dossier a rattacher" };
  }

  /* 7. Suivi de dossier */
  if (/mariage|reservation|acompte|solde|contrat|votre week-end|votre sejour|confirmation d'option|j - \d|j-\d/.test(tout)) {
    return { categorie: "client", dossier: "A rattacher",
      analyse: "Suivi de dossier — expediteur inconnu, a rattacher" };
  }

  /* 8. Demande entrante */
  if (/demande d'information|demande d'info|disponibilit|tarif|visite|renseignement|formulaire de demande|devis/.test(tout)) {
    return { categorie: "prospect", dossier: "Nouvelle demande",
      analyse: "Demande entrante (renseignements, disponibilites, tarifs)" };
  }

  return { categorie: "a_classer", dossier: null,
    analyse: "Non reconnu automatiquement — a classer manuellement" };
}

/* ---------- Un cycle de lecture ---------- */
async function cycle() {
  await chargerAnnuaire();

  const client = new ImapFlow({
    host: process.env.IMAP_HOST,
    port: parseInt(process.env.IMAP_PORT || "993", 10),
    secure: true,
    auth: { user: process.env.MAIL_UTILISATEUR, pass: process.env.MAIL_MOT_DE_PASSE },
    logger: false,
  });

  await client.connect();
  const boite = await client.getMailboxLock("INBOX", { readOnly: true });

  try {
    const { data: etat } = await supabase
      .from("mails_etat").select("dernier_uid").eq("id", 1).single();
    const depuis = (etat && etat.dernier_uid) || 0;

    let dernierUid = depuis;
    let nouveaux = 0;

    for await (const msg of client.fetch(
      { uid: `${depuis + 1}:*` },
      { uid: true, source: true, envelope: true }
    )) {
      if (msg.uid <= depuis) continue;

      const parsed = await simpleParser(msg.source);
      const from = (parsed.from && parsed.from.value && parsed.from.value[0]) || {};

      const corps = (parsed.text || "").trim();
      const pieces = (parsed.attachments || [])
        .filter((a) => a.filename)
        .map((a) => ({
          nom: a.filename,
          type: a.contentType || null,
          taille: a.size || null,
        }));

      const mail = {
        uid_imap: msg.uid,
        date_reception: parsed.date || (msg.envelope && msg.envelope.date) || new Date(),
        expediteur: from.name || null,
        expediteur_email: (from.address || "").toLowerCase() || null,
        objet: parsed.subject || "(sans objet)",
        extrait: corps ? corps.slice(0, 400) : null,
        corps: corps || null,
        pieces_jointes: pieces,
        lu: false,
        traite: false,
      };

      const { categorie, dossier, analyse } = classer(mail);
      mail.categorie = categorie;
      mail.dossier = dossier;
      mail.analyse = analyse;
      if (pieces.length) {
        mail.analyse += ` · ${pieces.length} piece(s) jointe(s) : ${pieces.map((p) => p.nom).join(", ")}`;
      }

      const { error } = await supabase
        .from("mails").upsert(mail, { onConflict: "uid_imap" });

      if (error) {
        console.log(`  ! Erreur ecriture UID ${msg.uid} : ${error.message}`);
      } else {
        nouveaux++;
        console.log(`  + [${categorie}${dossier ? " / " + dossier : ""}] ${mail.expediteur || mail.expediteur_email} — ${mail.objet}`);
      }

      if (msg.uid > dernierUid) dernierUid = msg.uid;
    }

    await supabase.from("mails_etat").upsert({
      id: 1,
      dernier_uid: dernierUid,
      derniere_verif: new Date(),
    });

    console.log(nouveaux
      ? `Cycle termine : ${nouveaux} nouveau(x) mail(s), dernier UID ${dernierUid}.`
      : `Cycle termine : rien de nouveau (dernier UID ${dernierUid}).`);
  } finally {
    boite.release();
    await client.logout();
  }
}

/* ---------- Boucle ---------- */
(async () => {
  console.log("CDL — Lecteur de boite mail v3 (LECTURE SEULE) demarre.");
  console.log(`Boite : ${process.env.MAIL_UTILISATEUR} · Serveur : ${process.env.IMAP_HOST}`);
  console.log(`Verification toutes les ${FREQ / 60000} minute(s).`);

  const boucle = async () => {
    try {
      await cycle();
    } catch (e) {
      console.log("Erreur cycle :", e.message, "— nouvel essai au prochain cycle.");
      if (e.responseText) console.log("  Reponse serveur :", e.responseText);
    }
  };

  await boucle();
  setInterval(boucle, FREQ);
})();
