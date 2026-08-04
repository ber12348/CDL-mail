
      /* ============================================================
   CDL — Lecteur de boite mail  ·  v3.1  ·  LECTURE SEULE
   ------------------------------------------------------------
   Corrections v3.1 :
     • "avoir" retire de la regle compta (matchait savoir/pouvoir)
     • adresses generiques (info@mariages.net, notify@lab-event,
       contact@domainedelacourdeslys) exclues de l'annuaire
     • demarchage et technique evalues AVANT les regles metier
     • expediteurs comptables reconnus (banques, PayFiP, URSSAF)
     • mails envoyes par le Domaine identifies comme tels
   Ne supprime, ne deplace et ne modifie JAMAIS un mail.
   ============================================================ */
const { ImapFlow } = require("imapflow");
const { simpleParser } = require("mailparser");
const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const FREQ = Math.max(1, parseInt(process.env.FREQUENCE_MINUTES || "3", 10)) * 60 * 1000;

/* ---------- Adresses a ne JAMAIS traiter comme un dossier ---------- */
const GENERIQUES = [
  "mariages.net", "mariage.net", "lab-event", "labevent", "bridebook",
  "zankyou", "1001salles", "abcsalles", "domainedelacourdeslys",
  "noreply", "no-reply", "ne-pas-repondre", "nepasrepondre",
  "notify@", "notification", "postmaster", "mailer-daemon",
];
const estGenerique = (a) => GENERIQUES.some((g) => (a || "").includes(g));

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
  let ecartes = 0;
  for (const d of data || []) {
    const cle = (d.email || "").trim().toLowerCase();
    if (!cle) continue;
    if (estGenerique(cle)) { ecartes++; continue; }
    const actuel = map.get(cle);
    if (!actuel || rang[d.statut] < rang[actuel.statut]) map.set(cle, d);
  }
  ANNUAIRE = map;
  console.log(`Annuaire charge : ${ANNUAIRE.size} adresses connues${ecartes ? ` (${ecartes} adresse(s) generique(s) ecartee(s))` : ""}.`);
}

/* ---------- Plateformes d'apport d'affaires ---------- */
const PLATEFORMES = ["mariages.net", "mariage.net", "lab-event", "labevent",
  "bridebook", "zankyou", "1001salles", "abcsalles"];

function adresseDansCorps(corps) {
  if (!corps) return null;
  const trouvees = corps.match(/[\w.+-]+@[\w-]+\.[\w.-]+/g) || [];
  for (const a of trouvees) {
    const propre = a.toLowerCase().replace(/[.,;)>\]]+$/, "");
    if (!estGenerique(propre) && !/sentry|wixpress|sendgrid|mailchimp|amazonses/.test(propre)) return propre;
  }
  return null;
}

/* ---------- Classement ---------- */
function classer(mail) {
  const de = (mail.expediteur_email || "").toLowerCase();
  const nomDe = (mail.expediteur || "").toLowerCase();
  const objet = (mail.objet || "").toLowerCase();
  const corps = (mail.corps || mail.extrait || "").toLowerCase();
  const tout = objet + " " + corps;

  const libelle = (d) => {
    const base = d.nom || d.contact || "Dossier";
    return d.date_debut ? `${base} · ${d.date_debut.slice(0, 4)}` : base;
  };

  /* 0. Mail envoye par le Domaine lui-meme (copie a soi, accuse) */
  if (de.includes("domainedelacourdeslys")) {
    return { categorie: "technique", dossier: null,
      analyse: "Message emis par le Domaine — copie interne" };
  }

  /* 1. TECHNIQUE : outils, notifications, codes — avant tout le reste */
  const OUTILS = ["render.com", "neon.tech", "supabase", "github", "vercel",
    "cloudflare", "ovh.com", "ovh.net", "anthropic", "claude.ai", "mammotion",
    "3douest", "apple.com", "google.com", "microsoft", "3cx", "search-console",
    "wordpress", "wix.com", "squarespace"];
  const CODES = /code de verification|verification code|2fa|double authentification|reinitialisation|password reset|verify your device|connexion detectee|message vocal|appel manque|memory limit|deploy/;
  if (OUTILS.some((m) => de.includes(m)) || CODES.test(tout)) {
    return { categorie: "technique", dossier: null,
      analyse: "Notification technique — aucune action commerciale" };
  }

  /* 2. DEMARCHAGE : sollicitations commerciales — avant les regles metier */
  const DEMARCHAGE_DE = ["sistrix", "dolcevita", "dolce-vita", "le-guide",
    "guerveur", "guinguette", "athezza", "mjt.lu", "mailjet", "sendinblue",
    "brevo", "studio-jfg", "monatelier", "romantictourist", "qweeby"];
  const DEMARCHAGE_TXT = /se desinscrire|desinscription|unsubscribe|votre visibilite|referencement|newsletter|webinar|nous serions ravis de|offre speciale|decouvrez notre|augmentez vos reservations|mettre en images vos/;
  if (DEMARCHAGE_DE.some((m) => de.includes(m) || nomDe.includes(m)) || DEMARCHAGE_TXT.test(tout)) {
    return { categorie: "demarchage", dossier: null,
      analyse: "Sollicitation commerciale externe — sans suite" };
  }

  /* 3. COMPTA par expediteur : banques, tresor, organismes */
  const COMPTA_DE = ["payfip", "sips-services", "credit-agricole", "creditagricole",
    "ca-normandie", "banque", "urssaf", "impots.gouv", "dgfip", "amazon.fr",
    "amazon.com", "sage", "cegid", "pennylane", "qonto", "stripe", "anett"];
  if (COMPTA_DE.some((m) => de.includes(m) || nomDe.includes(m))) {
    return { categorie: "compta", dossier: "Compta",
      analyse: "Piece comptable (banque, tresor public ou fournisseur)" };
  }

  /* 4. Expediteur connu : la reponse la plus fiable */
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
    return { categorie: "prospect", dossier: libelle(connu),
      analyse: "Ancien contact (dossier perdu) qui reecrit — piste a requalifier" };
  }

  /* 5. Plateforme : on cherche le couple derriere */
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

  /* 6. COMPTA par contenu — sans le mot "avoir" */
  if (/factur|releve bancaire|virement|prelevement|echeance de paiement|taxe de sejour|urssaf|impot|tva|comptabilit|declaration fiscale|ticket de paiement|note de frais|devis n°|avis de paiement/.test(tout)) {
    return { categorie: "compta", dossier: "Compta",
      analyse: "Piece comptable ou taxe — a rapprocher de l'exercice" };
  }

  /* 7. Document d'organisation */
  if (/rooming|plan de table|deroul[ée]|liste des invit|etat des lieux|caution|attestation d'assurance/.test(tout)) {
    return { categorie: "client", dossier: "A rattacher",
      analyse: "Document d'organisation — expediteur inconnu, dossier a rattacher" };
  }

  /* 8. Demande entrante */
  if (/demande d'information|demande d'info|demande de renseignement|disponibilit|votre tarif|vos tarifs|visite|brochure|formulaire de demande|nouvelle demande/.test(tout)) {
    return { categorie: "prospect", dossier: "Nouvelle demande",
      analyse: "Demande entrante (renseignements, disponibilites, tarifs)" };
  }

  /* 9. Suivi de dossier */
  if (/votre mariage|votre evenement|votre week-end|votre sejour|acompte|solde|contrat|confirmation d'option|j - ?\d|j-\d/.test(tout)) {
    return { categorie: "client", dossier: "A rattacher",
      analyse: "Suivi de dossier — expediteur inconnu, a rattacher" };
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
  console.log("CDL — Lecteur de boite mail v3.1 (LECTURE SEULE) demarre.");
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
