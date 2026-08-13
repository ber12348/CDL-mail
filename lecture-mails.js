/* ============================================================
   CDL — Lecteur de boite mail  ·  v6  ·  LECTURE SEULE (IMAP)
   ------------------------------------------------------------
   Nouveau en v6 :
     • les pieces jointes sont rangees dans Supabase Storage
       (coffre "pieces") et deviennent ouvrables depuis CDL.
       Au-dela de 15 Mo, seul le nom est garde, comme avant.
     • classement : l'annuaire des dossiers est consulte AVANT
       la regle "compta par expediteur" (une cliente ecrivant
       depuis sa banque n'est plus prise pour une facture), et
       les codes/notifications ne sont plus detectes que dans
       l'objet du mail (moins de faux "technique").
     • si le coffre "pieces" n'existe pas encore, tout fonctionne
       comme en v5 (verification a chaque cycle).
   Nouveau en v5 :
     • repond aux mails depuis CDL : surveille la table "reponses"
       (Supabase). Quand l'equipe demande un brouillon, Claude le
       redige ; quand l'equipe valide, l'envoi part par SMTP OVH.
       RIEN ne part sans validation humaine dans l'interface.
     • la boite reste en LECTURE SEULE cote IMAP : l'envoi passe
       par SMTP, un canal separe qui ne touche pas aux mails recus.
     • le Message-ID des nouveaux mails est memorise (colonne
       message_id) pour que les reponses s'attachent au bon fil.
     • si la table "reponses" ou la colonne "message_id" n'existent
       pas encore, tout fonctionne comme en v4 (verification a
       chaque cycle : passer le SQL suffit, sans redeployer).
   Nouveau en v4 :
     • quand les regles ne reconnaissent rien, le mail est soumis
       a Claude (Haiku) qui lit le message et propose un classement
     • les regles restent prioritaires : l'IA n'est appelee que
       sur les mails qui finiraient en "a classer" (peu d'appels)
     • si la cle ANTHROPIC_API_KEY est absente, tout fonctionne
       exactement comme en v3.2
   Ne supprime, ne deplace et ne modifie JAMAIS un mail recu.
   ============================================================ */
const { ImapFlow } = require("imapflow");
const { simpleParser } = require("mailparser");
const { createClient } = require("@supabase/supabase-js");
const nodemailer = require("nodemailer");

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const FREQ = Math.max(1, parseInt(process.env.FREQUENCE_MINUTES || "3", 10)) * 60 * 1000;

/* ---------- Envoi SMTP (reponses validees) ---------- */
const SMTP_HOST = process.env.SMTP_HOST || process.env.IMAP_HOST;
const SMTP_PORT = parseInt(process.env.SMTP_PORT || "465", 10);
const SIGNATURE = process.env.SIGNATURE || "L'equipe du Domaine de la Cour des Lys";
const EXPEDITEUR_NOM = process.env.EXPEDITEUR_NOM || "Domaine de la Cour des Lys";

const smtp = nodemailer.createTransport({
  host: SMTP_HOST,
  port: SMTP_PORT,
  secure: SMTP_PORT === 465,
  auth: { user: process.env.MAIL_UTILISATEUR, pass: process.env.MAIL_MOT_DE_PASSE },
});

/* ---------- Rangement des pieces jointes (Supabase Storage) ---------- */
const BUCKET = process.env.BUCKET_PIECES || "pieces";
const TAILLE_MAX_PJ = parseInt(process.env.TAILLE_MAX_PJ_MO || "15", 10) * 1024 * 1024;

/* Etat des extensions (re-verifie a chaque cycle tant que faux) */
let tableReponsesOK = false;
let colonneMessageIdOK = false;
let bucketOK = false;
let avertissementReponses = false;
let avertissementBucket = false;

async function verifierExtensionsV5() {
  if (!bucketOK) {
    const { error } = await supabase.storage.from(BUCKET).list("", { limit: 1 });
    if (!error) {
      bucketOK = true;
      console.log(`Pieces jointes : coffre '${BUCKET}' trouve, rangement actif.`);
    } else if (!avertissementBucket) {
      avertissementBucket = true;
      console.log(`Pieces jointes : coffre '${BUCKET}' absent — seuls les noms sont gardes (passer le SQL pour l'activer).`);
    }
  }
  if (!tableReponsesOK) {
    const { error } = await supabase.from("reponses").select("id").limit(1);
    if (!error) {
      tableReponsesOK = true;
      console.log("Reponses depuis CDL : table 'reponses' trouvee, envoi active.");
    } else if (!avertissementReponses) {
      avertissementReponses = true;
      console.log("Reponses depuis CDL : table 'reponses' absente — fonction en veille (passer le SQL pour l'activer).");
    }
  }
  if (!colonneMessageIdOK) {
    const { error } = await supabase.from("mails").select("message_id").limit(1);
    if (!error) colonneMessageIdOK = true;
  }
}

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


/* ---------- Appels a l'API Anthropic ---------- */
const CLE_IA = process.env.ANTHROPIC_API_KEY || "";
const MODELE_IA = process.env.MODELE_IA || "claude-haiku-4-5-20251001";
const MODELE_REDACTION = process.env.MODELE_REDACTION || "claude-sonnet-4-6";
let compteurIA = 0;

async function appelerClaude(modele, consigne, message, maxTokens) {
  const reponse = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": CLE_IA,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: modele,
      max_tokens: maxTokens,
      system: consigne,
      messages: [{ role: "user", content: message }],
    }),
  });
  if (!reponse.ok) throw new Error(`API Anthropic ${reponse.status}`);
  const data = await reponse.json();
  return (data.content || [])
    .map((b) => (b.type === "text" ? b.text : ""))
    .join("")
    .trim();
}

/* ---------- Classement par IA (dernier recours) ---------- */
const CATEGORIES_VALIDES = ["client", "prospect", "compta", "technique", "demarchage", "a_classer"];

async function classerParIA(mail) {
  if (!CLE_IA) return null;

  const consigne = `Tu classes les mails recus par le Domaine de la Cour des Lys, un lieu de reception en Normandie (mariages, seminaires, hebergement).

Reponds UNIQUEMENT par un objet JSON, sans texte autour, sans balises markdown :
{"categorie":"...","dossier":"...","analyse":"..."}

categorie doit valoir exactement l'une de ces valeurs :
- "prospect"   : quelqu'un se renseigne, demande un tarif, une visite, une disponibilite, envoie un formulaire de demande
- "client"     : echange avec un couple ou une entreprise dont l'evenement est deja reserve (organisation, rooming list, plan de table, acompte, J-3 mois...)
- "compta"     : facture, devis fournisseur, releve, prelevement, taxe, banque, expert-comptable, assurance
- "technique"  : notification automatique d'un outil, code de verification, message vocal, avis Google, maintenance
- "demarchage" : prospection commerciale entrante, newsletter, offre de service, referencement
- "a_classer"  : impossible de trancher

dossier : le nom du couple ou de la societe concernee si tu peux l'identifier dans le message, sinon null.
analyse : une phrase courte en francais expliquant ta decision, sans accent obligatoire.`;

  const message = `Expediteur : ${mail.expediteur || "(inconnu)"} <${mail.expediteur_email || "?"}>
Objet : ${mail.objet || "(sans objet)"}

Message :
${(mail.corps || mail.extrait || "(vide)").slice(0, 2000)}`;

  try {
    const texte = (await appelerClaude(MODELE_IA, consigne, message, 300))
      .replace(/```json|```/g, "")
      .trim();

    const avis = JSON.parse(texte);
    if (!CATEGORIES_VALIDES.includes(avis.categorie)) return null;

    compteurIA++;
    return {
      categorie: avis.categorie,
      dossier: avis.dossier || (avis.categorie === "compta" ? "Compta" : null),
      analyse: `${avis.analyse || "Classe par lecture du message"} (IA)`,
    };
  } catch (e) {
    console.log("  ! IA : ", e.message, "— classement par regles conserve.");
    return null;
  }
}

/* ---------- Redaction d'un brouillon de reponse ---------- */
async function redigerBrouillon(mail) {
  const consigne = `Tu rediges un brouillon de reponse a un mail recu par le Domaine de la Cour des Lys, un lieu de reception en Normandie (mariages, seminaires, hebergement). Ce brouillon sera relu, modifie et valide par un membre de l'equipe avant tout envoi.

Regles imperatives :
- Reponds en francais, vouvoiement, ton chaleureux et professionnel, sans emphase excessive.
- Sois concis : quelques phrases suffisent le plus souvent.
- N'invente JAMAIS une information factuelle : prix, date, disponibilite, nom, condition. Si la reponse en depend, ecris [A COMPLETER : ce qu'il faut verifier] a l'endroit voulu.
- Ne confirme jamais une reservation, une remise ou un engagement : propose, ou signale [A VERIFIER].
- Termine exactement par : "${SIGNATURE}"
- Reponds UNIQUEMENT avec le texte du mail, sans objet, sans balises, sans commentaire autour.`;

  let fiche = "";
  const connu = mail.expediteur_email && ANNUAIRE.get((mail.expediteur_email || "").toLowerCase());
  if (connu) {
    fiche = `\n\nFiche du dossier connu chez nous :
- Nom : ${connu.nom || connu.contact || "?"}
- Statut : ${connu.statut || "?"}
- Projet : ${connu.titre_projet || "?"}
- Date de l'evenement : ${connu.date_debut || "?"}`;
  }

  const message = `Mail recu, auquel il faut repondre :
Expediteur : ${mail.expediteur || "(inconnu)"} <${mail.expediteur_email || "?"}>
Objet : ${mail.objet || "(sans objet)"}
Categorie CDL : ${mail.categorie || "?"} · Dossier : ${mail.dossier || "aucun"}${fiche}

Corps du message :
${(mail.corps || mail.extrait || "(vide)").slice(0, 3000)}`;

  return appelerClaude(MODELE_REDACTION, consigne, message, 1000);
}

/* ---------- Traitement des reponses (brouillons + envois) ---------- */
let reponsesEnCours = false;

async function traiterReponses() {
  if (!tableReponsesOK || reponsesEnCours) return;
  reponsesEnCours = true;
  try {
    const { data, error } = await supabase
      .from("reponses")
      .select("*")
      .in("statut", ["brouillon_demande", "a_envoyer"])
      .order("cree_le", { ascending: true })
      .limit(10);
    if (error) { console.log("  ! Lecture reponses :", error.message); return; }

    for (const rep of data || []) {
      if (rep.statut === "brouillon_demande") await faireBrouillon(rep);
      else if (rep.statut === "a_envoyer") await faireEnvoi(rep);
    }
  } catch (e) {
    console.log("  ! Traitement reponses :", e.message);
  } finally {
    reponsesEnCours = false;
  }
}

/* Reserve une ligne (evite tout double traitement) : ne continue que si
   la ligne etait encore dans le statut attendu. */
async function reserver(rep, statutAttendu, statutEnCours) {
  const { data, error } = await supabase
    .from("reponses")
    .update({ statut: statutEnCours })
    .eq("id", rep.id)
    .eq("statut", statutAttendu)
    .select();
  return !error && data && data.length > 0;
}

async function majReponse(id, champs) {
  const { error } = await supabase.from("reponses").update(champs).eq("id", id);
  if (error) console.log(`  ! Mise a jour reponse ${id} :`, error.message);
}

async function faireBrouillon(rep) {
  if (!(await reserver(rep, "brouillon_demande", "brouillon_en_cours"))) return;
  if (!CLE_IA) {
    await majReponse(rep.id, { statut: "erreur", erreur: "Pas de cle ANTHROPIC_API_KEY sur le serveur." });
    return;
  }
  try {
    const { data: mail } = await supabase
      .from("mails").select("*").eq("id", rep.mail_id).single();
    if (!mail) throw new Error("mail introuvable en base");

    const brouillon = await redigerBrouillon(mail);
    if (!brouillon) throw new Error("reponse vide de l'IA");

    await majReponse(rep.id, { corps: brouillon, statut: "brouillon_pret", erreur: null });
    console.log(`  + Brouillon redige pour ${rep.destinataire} (reponse ${rep.id}).`);
  } catch (e) {
    console.log(`  ! Brouillon ${rep.id} :`, e.message);
    await majReponse(rep.id, { statut: "erreur", erreur: "Brouillon impossible : " + e.message });
  }
}

async function faireEnvoi(rep) {
  if (!(await reserver(rep, "a_envoyer", "envoi_en_cours"))) return;
  try {
    const dest = (rep.destinataire || "").trim();
    if (!/^[\w.+-]+@[\w-]+\.[\w.-]+$/.test(dest)) throw new Error("adresse destinataire invalide : " + dest);
    if (!rep.corps || !rep.corps.trim()) throw new Error("corps du message vide");

    let entetes = {};
    if (rep.mail_id && colonneMessageIdOK) {
      const { data: mail } = await supabase
        .from("mails").select("message_id").eq("id", rep.mail_id).single();
      if (mail && mail.message_id) {
        entetes = { inReplyTo: mail.message_id, references: mail.message_id };
      }
    }

    await smtp.sendMail({
      from: `"${EXPEDITEUR_NOM}" <${process.env.MAIL_UTILISATEUR}>`,
      to: dest,
      subject: rep.objet || "Re : votre message",
      text: rep.corps,
      ...entetes,
    });

    await majReponse(rep.id, { statut: "envoye", envoye_le: new Date(), erreur: null });
    console.log(`  + Reponse ${rep.id} envoyee a ${dest}.`);
  } catch (e) {
    console.log(`  ! Envoi ${rep.id} :`, e.message);
    await majReponse(rep.id, { statut: "erreur", erreur: "Envoi impossible : " + e.message });
  }
}

/* ---------- Classement par regles ---------- */
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

  /* 1. PLATEFORME d'apport d'affaires — traitee en premier :
        ce sont des leads, pas des notifications techniques */
  if (PLATEFORMES.some((p) => de.includes(p))) {
    // les vraies newsletters commerciales des plateformes restent du demarchage
    if (/newsletter|check-list|nouveaut|webinar|astuce|conseil du mois|business/.test(objet)) {
      return { categorie: "demarchage", dossier: null,
        analyse: "Communication commerciale de la plateforme — sans suite" };
    }
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

  /* 2. TECHNIQUE : outils, notifications, codes — avant tout le reste */
  const OUTILS = ["render.com", "neon.tech", "supabase", "github", "vercel",
    "cloudflare", "ovh.com", "ovh.net", "anthropic", "claude.ai", "mammotion",
    "3douest", "apple.com", "google.com", "microsoft", "3cx", "search-console",
    "wordpress", "wix.com", "squarespace"];
  const CODES = /code de verification|verification code|2fa|double authentification|reinitialisation|password reset|verify your device|connexion detectee|message vocal|appel manque|memory limit|deploy/;
  // v6 : les codes/notifications ne sont cherches que dans l'objet — un mail
  // de client qui *cite* un mot technique dans son texte n'est plus happe ici
  if (OUTILS.some((m) => de.includes(m)) || CODES.test(objet)) {
    return { categorie: "technique", dossier: null,
      analyse: "Notification technique — aucune action commerciale" };
  }

  /* 3. DEMARCHAGE : sollicitations commerciales — avant les regles metier */
  const DEMARCHAGE_DE = ["sistrix", "dolcevita", "dolce-vita", "le-guide",
    "guerveur", "guinguette", "athezza", "mjt.lu", "mailjet", "sendinblue",
    "brevo", "studio-jfg", "monatelier", "romantictourist", "qweeby"];
  const DEMARCHAGE_TXT = /se desinscrire|desinscription|unsubscribe|votre visibilite|referencement|newsletter|webinar|nous serions ravis de|offre speciale|decouvrez notre|augmentez vos reservations|mettre en images vos/;
  if (DEMARCHAGE_DE.some((m) => de.includes(m) || nomDe.includes(m)) || DEMARCHAGE_TXT.test(tout)) {
    return { categorie: "demarchage", dossier: null,
      analyse: "Sollicitation commerciale externe — sans suite" };
  }

  /* 4. Expediteur connu : la reponse la plus fiable — consultee AVANT la
        regle compta (v6) : une cliente qui ecrit depuis sa banque ou son
        entreprise reste une cliente, pas une facture */
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

  /* 5. COMPTA par expediteur : banques, tresor, organismes — mais pas si le
        mail parle manifestement d'un evenement chez nous */
  const COMPTA_DE = ["payfip", "sips-services", "credit-agricole", "creditagricole",
    "ca-normandie", "banque", "urssaf", "impots.gouv", "dgfip", "amazon.fr",
    "amazon.com", "sage", "cegid", "pennylane", "qonto", "stripe", "anett"];
  if (COMPTA_DE.some((m) => de.includes(m) || nomDe.includes(m))) {
    if (/votre evenement|votre événement|votre mariage|votre seminaire|votre séminaire|devis pour votre|au domaine de la cour des lys/.test(tout)) {
      return { categorie: "prospect", dossier: "A rattacher",
        analyse: "Expediteur type banque mais le mail parle d'un evenement chez nous — a rattacher" };
    }
    return { categorie: "compta", dossier: "Compta",
      analyse: "Piece comptable (banque, tresor public ou fournisseur)" };
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
  await verifierExtensionsV5();
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
      const pieces = [];
      for (const a of parsed.attachments || []) {
        if (!a.filename) continue;
        const piece = { nom: a.filename, type: a.contentType || null, taille: a.size || null };
        if (bucketOK && a.content && (a.size || 0) <= TAILLE_MAX_PJ) {
          const nomSur = a.filename.replace(/[^\w.\-]+/g, "_").slice(-80);
          const chemin = `${msg.uid}/${pieces.length + 1}-${nomSur}`;
          const { error: errPJ } = await supabase.storage.from(BUCKET).upload(chemin, a.content, {
            contentType: a.contentType || "application/octet-stream",
            upsert: true,
          });
          if (!errPJ) piece.chemin = chemin;
          else console.log(`  ! Piece jointe '${a.filename}' non rangee : ${errPJ.message}`);
        }
        pieces.push(piece);
      }

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
      if (colonneMessageIdOK) mail.message_id = parsed.messageId || null;

      let { categorie, dossier, analyse } = classer(mail);

      // les regles n'ont rien reconnu : on demande son avis a l'IA
      if (categorie === "a_classer") {
        const avis = await classerParIA(mail);
        if (avis) ({ categorie, dossier, analyse } = avis);
      }

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
      ? `Cycle termine : ${nouveaux} nouveau(x) mail(s), dernier UID ${dernierUid}${compteurIA ? `, dont ${compteurIA} classe(s) par l'IA` : ""}.`
      : `Cycle termine : rien de nouveau (dernier UID ${dernierUid}).`);
    compteurIA = 0;
  } finally {
    boite.release();
    await client.logout();
  }
}

/* ---------- Boucle ---------- */
(async () => {
  console.log("CDL — Lecteur de boite mail v6 (LECTURE SEULE cote IMAP) demarre.");
  console.log(`Boite : ${process.env.MAIL_UTILISATEUR} · Serveur : ${process.env.IMAP_HOST}`);
  console.log(`Verification toutes les ${FREQ / 60000} minute(s) · reponses relevees toutes les 30 s.`);
  console.log(CLE_IA
    ? `Classement par IA actif (${MODELE_IA}) en secours des regles · brouillons rediges par ${MODELE_REDACTION}.`
    : "Classement par regles seules (pas de cle ANTHROPIC_API_KEY) — brouillons IA indisponibles.");
  console.log(`Envoi SMTP : ${SMTP_HOST}:${SMTP_PORT} (uniquement les reponses validees dans CDL).`);

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
  setInterval(traiterReponses, 30000);
})();
