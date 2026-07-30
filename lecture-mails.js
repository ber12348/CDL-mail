/* ============================================================
   CDL — Lecteur de boîte mail OVH (v1 · LECTURE SEULE)
   ------------------------------------------------------------
   • Se connecte en IMAP à contact@domainedelacourdeslys.com
   • Lit UNIQUEMENT les nouveaux messages (jamais de suppression,
     jamais de modification, pas même le marquage "lu")
   • Classe chaque mail (règles simples + IA Claude si clé fournie)
   • Écrit le résultat dans Supabase (tables mails / mails_etat)
   ============================================================ */
require("dotenv").config();
const { ImapFlow } = require("imapflow");
const { simpleParser } = require("mailparser");
const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const FREQ = Math.max(2, parseInt(process.env.FREQUENCE_MINUTES || "3", 10)) * 60 * 1000;

/* ---------- Classement par règles simples (toujours actif) ---------- */
function classerParRegles(mail) {
  const objet = (mail.objet || "").toLowerCase();
  const corps = (mail.extrait || "").toLowerCase();
  const exp = (mail.expediteur_email || "").toLowerCase();
  const texte = objet + " " + corps;

  if (/facture|avis de pr[ée]l[èe]vement|[ée]ch[ée]ance|relev[ée]/.test(texte) &&
      /(traiteur|orange|engie|edf|ovh|assurance|thelem|groupama|loison|grandsire|sp-traiteur)/.test(exp + " " + texte))
    return { categorie: "compta", dossier: "Compta", analyse_cdl: "Facture ou avis fournisseur détecté → Comptabilité › À valider" };

  if (/rooming|liste (des )?invit[ée]s|plan de table|fiche mobilier|d[ée]roul[ée]/.test(texte))
    return { categorie: "client", dossier: null, analyse_cdl: "Document d'organisation client détecté (rooming/invités/plan)" };

  if (/demande|disponibilit[ée]|mariage.*(2027|2028|2029)|visite|brochure|tarif/.test(texte))
    return { categorie: "prospect", dossier: "Prospects", analyse_cdl: "Demande entrante ou question tarifaire → pipeline prospects" };

  if (/mariages\.net|zankyou|bridebook/.test(exp))
    return { categorie: "prospect", dossier: "Prospects", analyse_cdl: "Lead entrant via portail mariage" };

  return { categorie: "a_classer", dossier: null, analyse_cdl: "À classer manuellement (aucune règle ne correspond)" };
}

/* ---------- Classement IA (optionnel, si ANTHROPIC_API_KEY) ---------- */
async function classerParIA(mail) {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 300,
        messages: [{
          role: "user",
          content: `Tu classes les mails du Domaine de la Cour des Lys (lieu de mariages et séminaires en Normandie).
Catégories possibles : client (couple ayant signé), prospect (demande/visite avant signature), compta (facture ou fournisseur), prestataire (traiteur/DJ/photographe partenaire), autre.
Réponds UNIQUEMENT en JSON : {"categorie":"...","dossier":"NomDuCouple ou Compta ou Prospects ou null","analyse_cdl":"une phrase expliquant le classement et l'action utile"}

Expéditeur : ${mail.expediteur} <${mail.expediteur_email}>
Objet : ${mail.objet}
Extrait : ${(mail.extrait || "").slice(0, 800)}
Pièces jointes : ${mail.pieces_jointes.map(p => p.nom).join(", ") || "aucune"}`,
        }],
      }),
    });
    const data = await r.json();
    const texte = (data.content || []).map(c => c.text || "").join("").replace(/```json|```/g, "").trim();
    const j = JSON.parse(texte);
    if (j && j.categorie) return j;
  } catch (e) {
    console.log("  IA indisponible, classement par règles conservé (", e.message, ")");
  }
  return null;
}

/* ---------- Un cycle de lecture ---------- */
async function verifier() {
  const client = new ImapFlow({
    host: process.env.IMAP_HOST,
    port: parseInt(process.env.IMAP_PORT || "993", 10),
    secure: true,
    auth: { user: process.env.MAIL_UTILISATEUR, pass: process.env.MAIL_MOT_DE_PASSE },
    logger: false,
  });

  const { data: etat } = await supabase.from("mails_etat").select("dernier_uid").eq("id", 1).single();
  const dernierUid = (etat && etat.dernier_uid) || 0;

  await client.connect();
  // LECTURE SEULE : la boîte est ouverte en mode readOnly, rien ne peut être modifié
  const boite = await client.getMailboxLock("INBOX", { readOnly: true });
  let maxUid = dernierUid;
  let nouveaux = 0;

  try {
    for await (const msg of client.fetch({ uid: `${dernierUid + 1}:*` }, { uid: true, source: true }, { uid: true })) {
      if (msg.uid <= dernierUid) continue; // sécurité
      const parse = await simpleParser(msg.source);
      const mail = {
        uid_imap: msg.uid,
        date_reception: parse.date ? parse.date.toISOString() : new Date().toISOString(),
        expediteur: (parse.from && parse.from.value[0] && parse.from.value[0].name) || "",
        expediteur_email: (parse.from && parse.from.value[0] && parse.from.value[0].address) || "",
        objet: parse.subject || "(sans objet)",
        extrait: (parse.text || "").slice(0, 1500),
        corps: (parse.text || "").slice(0, 20000),
        pieces_jointes: (parse.attachments || []).map(a => ({ nom: a.filename, taille: a.size, type: a.contentType })),
      };

      let classement = classerParRegles(mail);
      const ia = await classerParIA(mail);
      if (ia) classement = ia;

      const { error } = await supabase.from("mails").upsert(
        { ...mail, ...classement },
        { onConflict: "uid_imap" }
      );
      if (error) console.log("  ⚠ Supabase :", error.message);
      else {
        nouveaux++;
        console.log(`  ✉ [${classement.categorie}] ${mail.expediteur_email} — ${mail.objet}`);
      }
      if (msg.uid > maxUid) maxUid = msg.uid;
    }
  } finally {
    boite.release();
    await client.logout();
  }

  await supabase.from("mails_etat").upsert({ id: 1, dernier_uid: maxUid, derniere_verif: new Date().toISOString() });
  console.log(`${new Date().toLocaleTimeString("fr-FR")} — ${nouveaux} nouveau(x) mail(s) classé(s). Prochaine vérification dans ${FREQ / 60000} min.`);
}

/* ---------- Boucle ---------- */
(async function boucle() {
  console.log("CDL — Lecteur de boîte mail (LECTURE SEULE) démarré.");
  console.log("Boîte :", process.env.MAIL_UTILISATEUR, "· Serveur :", process.env.IMAP_HOST);
  for (;;) {
    try { await verifier(); }
    catch (e) { console.log("⚠ Erreur cycle :", e.message, "— nouvel essai au prochain cycle."); }
    await new Promise(r => setTimeout(r, FREQ));
  }
})();
