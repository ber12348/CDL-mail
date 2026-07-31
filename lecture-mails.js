/* ============================================================
   CDL — Lecteur de boîte mail OVH (v1.2 · LECTURE SEULE)
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
   ------------------------------------------------------------ */
function classer(mail) {
  const objet = (mail.objet || "").toLowerCase();
  const corps = (mail.extrait || "").toLowerCase();
  const exp = (mail.expediteur_email || "").toLowerCase();
  const texte = objet + " " + corps;

  if (
    /facture|avis de pr[ée]l[èe]vement|[ée]ch[ée]ance|relev[ée]|devis fournisseur/.test(texte) ||
    /(traiteur|orange|engie|edf|ovh|assurance|thelem|groupama|loison|grandsire|sp-traiteur|urssaf|cegestion)/.test(exp)
  ) {
    return {
      categorie: "compta",
      dossier: "Compta",
      analyse: "Facture ou avis fournisseur détecté → Comptabilité · À valider",
    };
  }

  if (/rooming|liste (des )?invit[ée]s|plan de table|fiche mobilier|d[ée]roul[ée]|canap[ée]|h[ée]bergement/.test(texte)) {
    return {
      categorie: "client",
      dossier: null,
      analyse: "Document d'organisation client (rooming / invités / plan / hébergement)",
    };
  }

  if (/demande de (dispo|renseignement)|disponibilit[ée]|visite|tarif|mariage.{0,30}(20\d\d)|mariages\.net|zankyou|devis/.test(texte)) {
    return {
      categorie: "prospect",
      dossier: "Prospects",
      analyse: "Demande entrante : disponibilités, tarifs ou visite → Prospects",
    };
  }

  if (/newsletter|d[ée]sinscri|se d[ée]sabonner|no-?reply|promotion/.test(texte + " " + exp)) {
    return { categorie: "info", dossier: null, analyse: "Message d'information / newsletter" };
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
async function cycle() {
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

console.log("CDL — Lecteur de boîte mail (LECTURE SEULE) v1.2 démarré");
console.log(`Serveur ${process.env.IMAP_HOST} · relève toutes les ${FREQ / 60000} min · max ${MAX_PAR_CYCLE} mails/cycle`);
boucle();
