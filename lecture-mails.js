/* ============================================================
   CDL — Lecteur de boîte mail OVH (v1.3 · LECTURE SEULE)
   ------------------------------------------------------------
   CORRECTIF v1.1 — dépassement mémoire (512 Mo) sur Render :
     • on ne télécharge PLUS le message entier ;
       seuls l'en-tête (expéditeur, objet, date) et un extrait
       de texte limité à 60 Ko sont récupérés ;
     • les PIÈCES JOINTES ne sont jamais téléchargées ;
     • les mails sont traités UN PAR UN et enregistrés au fil
       de l'eau (plus rien n'est accumulé en mémoire) ;
     • au maximum 25 mails par cycle ;
     • un seul cycle à la fois (plus de chevauchement).

   GARANTIE INCHANGÉE : la boîte est ouverte en LECTURE SEULE.
   Le programme est techniquement incapable de supprimer,
   déplacer, ou même marquer un mail comme lu.
   ============================================================ */
require("dotenv").config();
const { ImapFlow } = require("imapflow");
const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const FREQ = Math.max(2, parseInt(process.env.FREQUENCE_MINUTES || "3", 10)) * 60 * 1000;
const MAX_PAR_CYCLE = 25;      // nb de mails traités par passage
const MAX_OCTETS_TEXTE = 60000; // taille max du corps téléchargé
const MAX_EXTRAIT = 2000;       // taille de l'extrait stocké
const PREMIER_LOT = 30;         // au tout premier démarrage, on remonte 30 mails

/* ------------------------------------------------------------
   1. CLASSEMENT PAR RÈGLES (aucune IA, aucun coût, peu de RAM)
   Règles calibrées sur les vrais mails CDL du 31/07/2026.
   ------------------------------------------------------------ */

// Boîtes grand public : l'adresse ne dit RIEN du rôle de l'expéditeur.
// (c'est ce qui faisait passer vos clients en @orange.fr pour des factures)
const BOITE_GRAND_PUBLIC = /@(orange|wanadoo|free|sfr|neuf|laposte|gmail|googlemail|yahoo|ymail|hotmail|outlook|live|msn|icloud|me\.com|bbox|numericable|aol)\./;

// Vrais domaines de vos fournisseurs / organismes
const DOMAINE_FOURNISSEUR = /@([a-z0-9.-]*)(sp-traiteur|thelem|groupama|cegestion|ovh|engie|edf|urssaf|impots\.gouv|3douest|caenlamer|caen-la-mer|loison|grandsire|malakoff|ag2r|legalplace)\./;

function classer(mail) {
  const objet = (mail.objet || "").toLowerCase();
  const corps = (mail.extrait || "").toLowerCase();
  const exp = (mail.expediteur_email || "").toLowerCase();
  const texte = objet + " " + corps;

  /* 1 — VOTRE PROPRE ADRESSE : copie d'un envoi, pas un mail entrant */
  if (exp.includes("@domainedelacourdeslys.com")) {
    return {
      categorie: "interne",
      dossier: null,
      analyse: "Expédié depuis la boîte CDL — copie d'un envoi sortant",
    };
  }

  /* 2 — COMPTABILITÉ : facture, taxe, cotisation, prélèvement */
  const motCompta = /facture|avoir n|pr[ée]l[èe]vement|[ée]ch[ée]ance|relev[ée] de compte|taxe de s[ée]jour|cotisation|appel de fonds|d[ée]claration (fiscale|tva|urssaf)|bulletin de paie|note d'honoraires/.test(texte);
  const estFournisseur = DOMAINE_FOURNISSEUR.test(exp) && !BOITE_GRAND_PUBLIC.test(exp);
  if (motCompta || (estFournisseur && /paiement|montant|r[èe]glement|€|euros? ht/.test(texte))) {
    return {
      categorie: "compta",
      dossier: "Compta",
      analyse: "Pièce comptable ou taxe → Comptabilité · À valider",
    };
  }

  /* 3 — DÉMARCHAGE : on vous vend quelque chose (avant client/prospect,
        car ces mails parlent aussi de « mariage », « tarif », « événement ») */
  if (
    /mettre en images|votre visibilit[ée]|r[ée]f[ée]rencement|boostez|augmentez vos r[ée]servations|d[ée]couvrez notre (offre|solution)|notre agence|proposition de partenariat|nous accompagnons les (domaines|lieux)|essai gratuit|webinaire/.test(texte) ||
    /\b(unsubscribe|our (team|love|offer)|we would like|best regards|click here|free trial)\b/.test(texte)
  ) {
    return {
      categorie: "demarchage",
      dossier: null,
      analyse: "Sollicitation commerciale entrante — sans suite a priori",
    };
  }

  /* 4 — CLIENT : dossier déjà signé, on organise l'événement */
  if (
    /\bj\s*-\s*\d+\s*(mois|jours|semaines)\b/.test(texte) ||
    /rooming|plan de (table|salle)|liste (des )?invit[ée]s|fiche mobilier|d[ée]roul[ée]|h[ée]bergement|canap[ée]s?-?lits?|r[ée]partition des chambres|votre (mariage|[ée]v[ée]nement) au domaine/.test(texte)
  ) {
    return {
      categorie: "client",
      dossier: null,
      analyse: "Dossier en cours d'organisation → Client",
    };
  }

  /* 5 — PROSPECT : demande entrante, pas encore signée */
  if (
    /mariages\.net|zankyou|lab-event|formulaire de demande/.test(exp + " " + texte) ||
    /demande de (renseignements?|d[ée]vis|visite|dispo)|demande d'information|disponibilit[ée]s?|confirmation de votre visite|visite du domaine|vos tarifs|grille tarifaire|pose(r)? une option|confirmation d'option/.test(texte)
  ) {
    return {
      categorie: "prospect",
      dossier: "Prospects",
      analyse: "Demande entrante (renseignements, visite, option) → Prospects",
    };
  }

  /* 6 — INFO / TECHNIQUE : notifications automatiques */
  if (
    /^(no-?reply|ne-?pas-?repondre|notifications?|alerte?s?)@/.test(exp) ||
    /code de v[ée]rification|password reset|r[ée]initialisation.{0,20}mot de passe|confirmation d'inscription|memory limit|deploy/.test(texte)
  ) {
    return {
      categorie: "info",
      dossier: null,
      analyse: "Notification automatique — aucune action attendue",
    };
  }

  return { categorie: "a_classer", dossier: null, analyse: "Non reconnu automatiquement — à classer à la main" };
}

/* ------------------------------------------------------------
   2. OUTILS
   ------------------------------------------------------------ */

// Repère la première partie texte du message SANS rien télécharger.
// On ignore délibérément tout ce qui est pièce jointe (image, PDF…).
function trouverPartieTexte(node) {
  if (!node) return null;
  const type = (node.type || "").toLowerCase();
  const disposition = (node.disposition || "").toLowerCase();

  if (disposition === "attachment") return null; // jamais de pièce jointe

  if (type === "text/plain" && node.part) return { part: node.part, html: false };
  if (type === "text/html" && node.part) return { part: node.part, html: true };

  if (Array.isArray(node.childNodes)) {
    // priorité au texte brut, plus léger et plus propre
    for (const enfant of node.childNodes) {
      const t = trouverPartieTexte(enfant);
      if (t && !t.html) return t;
    }
    for (const enfant of node.childNodes) {
      const t = trouverPartieTexte(enfant);
      if (t) return t;
    }
  }
  return null;
}

// Lit un flux en s'arrêtant net au plafond : la mémoire ne peut pas déraper.
async function lireFluxLimite(flux, maxOctets) {
  let texte = "";
  for await (const morceau of flux) {
    texte += morceau.toString("utf8");
    if (texte.length >= maxOctets) {
      if (typeof flux.destroy === "function") flux.destroy();
      break;
    }
  }
  return texte.slice(0, maxOctets);
}

function nettoyer(texte, estHtml) {
  let t = texte || "";
  if (estHtml) {
    t = t
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">");
  }
  return t.replace(/\s+/g, " ").trim().slice(0, MAX_EXTRAIT);
}

/* ------------------------------------------------------------
   3. SUPABASE
   ------------------------------------------------------------ */
async function lireDernierUid() {
  const { data, error } = await supabase
    .from("mails_etat")
    .select("dernier_uid")
    .eq("id", 1)
    .maybeSingle();
  if (error) {
    console.error("Lecture mails_etat impossible :", error.message);
    return null;
  }
  return data ? Number(data.dernier_uid || 0) : 0;
}

async function ecrireDernierUid(uid) {
  const { error } = await supabase
    .from("mails_etat")
    .upsert({ id: 1, dernier_uid: uid, derniere_verif: new Date().toISOString() });
  if (error) console.error("Écriture mails_etat impossible :", error.message);
}

// Insertion tolérante : si une colonne n'existe pas dans la table,
// on la retire et on réessaie, au lieu de tout perdre.
async function insererMail(ligne) {
  let candidat = { ...ligne };
  for (let essai = 0; essai < 6; essai++) {
    const { error } = await supabase.from("mails").insert(candidat);
    if (!error) return true;

    const colonne = (error.message || "").match(/'([a-z_]+)' column/i);
    if (colonne && colonne[1] && colonne[1] in candidat) {
      console.warn(`Colonne « ${colonne[1] } » absente de la table : ignorée.`);
      delete candidat[colonne[1]];
      continue;
    }
    if ((error.code || "") === "23505") return true; // doublon : déjà enregistré
    console.error("Insertion refusée :", error.message);
    return false;
  }
  return false;
}

/* ------------------------------------------------------------
   4. CYCLE DE RELÈVE
   ------------------------------------------------------------ */

/* Option de RELECTURE (variable RELIRE = oui dans Render).
   Efface les mails déjà rangés dans la table CDL et les reclasse
   avec les nouvelles règles. N'a AUCUN effet sur la boîte OVH,
   qui reste en lecture seule. À retirer après le test. */
let relectureFaite = false;
async function relectureEventuelle() {
  if (relectureFaite) return;
  relectureFaite = true;
  if ((process.env.RELIRE || "").toLowerCase() !== "oui") return;

  console.log("RELIRE=oui → remise à zéro de la table CDL pour reclasser les mails.");
  const { error } = await supabase.from("mails").delete().gte("id", 0);
  if (error) console.error("Vidage de la table impossible :", error.message);
  await ecrireDernierUid(0);
}

async function cycle() {
  await relectureEventuelle();

  const client = new ImapFlow({
    host: process.env.IMAP_HOST,
    port: parseInt(process.env.IMAP_PORT || "993", 10),
    secure: true,
    auth: {
      user: process.env.MAIL_UTILISATEUR,
      pass: (process.env.MAIL_MOT_DE_PASSE || "").trim(), // espace parasite neutralisé
    },
    logger: false,
  });

  let lock = null;
  try {
    await client.connect();
    lock = await client.getMailboxLock("INBOX", { readOnly: true }); // LECTURE SEULE

    const uidNext = client.mailbox.uidNext || 1;
    let dernier = await lireDernierUid();

    if (dernier === null) return; // Supabase injoignable, on retentera
    if (!dernier) {
      dernier = Math.max(0, uidNext - PREMIER_LOT - 1);
      console.log(`Premier démarrage : reprise des ~${PREMIER_LOT} derniers mails.`);
    }

    if (uidNext - 1 <= dernier) {
      console.log("Aucun nouveau mail.");
      return;
    }

    let traites = 0;
    let plusHautUid = dernier;

    /* ÉTAPE 1 — on collecte UNIQUEMENT les en-têtes.
       Aucune autre commande IMAP n'est permise pendant cette boucle :
       tout téléchargement ici bloquerait la connexion. */
    const aTraiter = [];
    for await (const msg of client.fetch(
      `${dernier + 1}:*`,
      { uid: true, envelope: true, bodyStructure: true, internalDate: true },
      { uid: true }
    )) {
      if (msg.uid <= dernier) continue;        // quirk IMAP : le dernier message revient toujours
      if (aTraiter.length >= MAX_PAR_CYCLE) break;
      aTraiter.push({
        uid: msg.uid,
        envelope: msg.envelope || {},
        internalDate: msg.internalDate,
        partie: trouverPartieTexte(msg.bodyStructure), // repérage seul, rien n'est téléchargé
      });
    }
    console.log(`${aTraiter.length} mail(s) à traiter.`);

    /* ÉTAPE 2 — la liste est close, la connexion est libre :
       on peut maintenant télécharger les textes un par un. */
    for (const msg of aTraiter) {
      const env = msg.envelope;
      const de = (env.from && env.from[0]) || {};

      // --- extrait de texte, plafonné, sans pièce jointe ---
      let extrait = "";
      try {
        if (msg.partie) {
          const { content } = await client.download(msg.uid, msg.partie.part, {
            uid: true,
            maxBytes: MAX_OCTETS_TEXTE,
          });
          extrait = nettoyer(await lireFluxLimite(content, MAX_OCTETS_TEXTE), msg.partie.html);
        }
      } catch (e) {
        console.warn(`UID ${msg.uid} : corps illisible (${e.message}) — en-tête conservé.`);
      }

      const base = {
        uid_imap: msg.uid,
        date_reception: (env.date || msg.internalDate || new Date()).toISOString(),
        expediteur_email: de.address || null,
        objet: env.subject || "(sans objet)",
        extrait,
      };
      const verdict = classer(base);

      const ok = await insererMail({ ...base, ...verdict });
      if (ok) {
        traites++;
        plusHautUid = Math.max(plusHautUid, msg.uid);
        await ecrireDernierUid(plusHautUid); // reprise exacte même si on plante
        console.log(`✓ ${verdict.categorie.padEnd(10)} | ${base.expediteur_email || "?"} | ${base.objet.slice(0, 60)}`);
      }
    }

    const mo = Math.round(process.memoryUsage().rss / 1048576);
    console.log(`Cycle terminé : ${traites} mail(s) traité(s) · mémoire ${mo} Mo`);
  } catch (e) {
    console.error("Erreur du cycle :", e.message);
  } finally {
    if (lock) lock.release();
    try {
      await client.logout();
    } catch (_) {
      /* connexion déjà fermée */
    }
  }
}

/* ------------------------------------------------------------
   5. BOUCLE — un cycle à la fois, jamais en parallèle
   ------------------------------------------------------------ */
async function boucle() {
  await cycle();
  if (global.gc) global.gc();
  setTimeout(boucle, FREQ);
}

process.on("unhandledRejection", (e) => console.error("Rejet non géré :", e && e.message));
process.on("uncaughtException", (e) => console.error("Exception non gérée :", e && e.message));

console.log("CDL — Lecteur de boîte mail (LECTURE SEULE) v1.3 démarré");
console.log(`Serveur ${process.env.IMAP_HOST} · relève toutes les ${FREQ / 60000} min · max ${MAX_PAR_CYCLE} mails/cycle`);
boucle();
