/* ============================================================
   CDL — Lecteur de boite mail  ·  v2  ·  LECTURE SEULE
   ------------------------------------------------------------
   Nouveautes v2 :
     • nom de l'expediteur (et plus seulement son adresse)
     • corps complet du mail (pour affichage + reponse dans CDL)
     • liste des pieces jointes (nom, type, taille)
     • nouvelle categorie "pub" pour la publicite pure
   Ne supprime, ne deplace et ne modifie JAMAIS un mail.
   ============================================================ */
const { ImapFlow } = require("imapflow");
const { simpleParser } = require("mailparser");
const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const FREQ = Math.max(1, parseInt(process.env.FREQUENCE_MINUTES || "3", 10)) * 60 * 1000;

/* ---------- Classement par regles ---------- */
function classer(mail) {
  const de = (mail.expediteur_email || "").toLowerCase();
  const objet = (mail.objet || "").toLowerCase();
  const corps = (mail.extrait || "").toLowerCase();
  const tout = objet + " " + corps;

  // 1. Publicite / newsletters commerciales
  const PUB = ["sistrix", "dolcevita", "dolce-vita", "newsletter", "promo", "webinar",
    "mjt.lu", "mailjet", "sendinblue", "brevo", "unsubscribe", "desinscri"];
  if (PUB.some((m) => de.includes(m) || tout.includes(m))) {
    return { categorie: "pub", analyse: "Publicite ou newsletter commerciale" };
  }

  // 2. Interne : outils techniques du Domaine
  const INTERNE = ["render.com", "neon.tech", "supabase", "github", "vercel", "cloudflare", "ovh"];
  if (INTERNE.some((m) => de.includes(m))) {
    return { categorie: "interne", analyse: "Notification d'un outil technique du Domaine" };
  }

  // 3. Compta
  if (/factur|devis sign|avoir|relev|virement|taxe de sejour|urssaf|impot|tva|comptab|cegestion/.test(tout)) {
    return { categorie: "compta", analyse: "Facture ou piece comptable detectee -> a rapprocher" };
  }

  // 4. Client : document d'organisation
  if (/rooming|plan de table|deroul|liste des invit|traiteur|dj |photographe|etat des lieux|caution|assurance/.test(tout)) {
    return { categorie: "client", analyse: "Document d'organisation client (rooming list, deroule...)" };
  }

  // 5. Client : suivi de dossier
  if (/mariage|reservation|acompte|solde|contrat|votre week-end|votre sejour|j - \d|j-\d/.test(tout)) {
    return { categorie: "client", analyse: "Suivi de dossier client" };
  }

  // 6. Prospect : demande entrante
  if (/mariages\.net|demande d'information|demande d'info|disponibilit|tarif|visite|renseignement|formulaire de demande/.test(tout)) {
    return { categorie: "prospect", analyse: "Demande entrante : disponibilites, tarifs, visite" };
  }

  return { categorie: "a_classer", analyse: "Non reconnu automatiquement — a classer manuellement" };
}

/* ---------- Un cycle de lecture ---------- */
async function cycle() {
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
    // Reprise a partir du dernier UID traite
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

      const { categorie, analyse } = classer(mail);
      mail.categorie = categorie;
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
        console.log(`  + [${categorie}] ${mail.expediteur || mail.expediteur_email} — ${mail.objet}`);
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
  console.log("CDL — Lecteur de boite mail v2 (LECTURE SEULE) demarre.");
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
