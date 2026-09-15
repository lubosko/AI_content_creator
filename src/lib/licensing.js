"use strict";
/* Rights records, and the gate that keeps material nobody has the right to use out of a rendered
   video. The gate is deliberately conservative: material whose licence was never recorded is
   blocked, not assumed to be fine. It encodes the constraints the common licences actually impose
   on a monetised video, and refuses to guess the ones it cannot resolve. Not legal advice. */

const LICENCES = {
  own:          {short:"Own work", label:"My own recording, artwork or writing", reuse:true,  commercial:true,  derivatives:true,  attribution:false, shareAlike:false, self_owned:true,  url:null},
  permission:   {short:"Permission", label:"Written permission from the rights holder", reuse:true, commercial:true, derivatives:true, attribution:false, shareAlike:false, url:null},
  cc0:          {short:"CC0", label:"CC0 1.0 public domain dedication", reuse:true, commercial:true, derivatives:true, attribution:false, shareAlike:false, url:"https://creativecommons.org/publicdomain/zero/1.0/"},
  public_domain:{short:"Public domain", label:"Public domain (copyright expired)", reuse:true, commercial:true, derivatives:true, attribution:false, shareAlike:false, url:null},
  cc_by:        {short:"CC BY", label:"Creative Commons Attribution (CC BY)", reuse:true, commercial:true, derivatives:true, attribution:true, shareAlike:false, url:"https://creativecommons.org/licenses/by/4.0/"},
  cc_by_sa:     {short:"CC BY-SA", label:"Creative Commons Attribution-ShareAlike (CC BY-SA)", reuse:true, commercial:true, derivatives:true, attribution:true, shareAlike:true, url:"https://creativecommons.org/licenses/by-sa/4.0/"},
  cc_by_nc:     {short:"CC BY-NC", label:"Creative Commons Attribution-NonCommercial (CC BY-NC)", reuse:true, commercial:false, derivatives:true, attribution:true, shareAlike:false, url:"https://creativecommons.org/licenses/by-nc/4.0/"},
  cc_by_nd:     {short:"CC BY-ND", label:"Creative Commons Attribution-NoDerivatives (CC BY-ND)", reuse:true, commercial:true, derivatives:false, attribution:true, shareAlike:false, url:"https://creativecommons.org/licenses/by-nd/4.0/"},
  cc_by_nc_sa:  {short:"CC BY-NC-SA", label:"Creative Commons Attribution-NonCommercial-ShareAlike (CC BY-NC-SA)", reuse:true, commercial:false, derivatives:true, attribution:true, shareAlike:true, url:"https://creativecommons.org/licenses/by-nc-sa/4.0/"},
  cc_by_nc_nd:  {short:"CC BY-NC-ND", label:"Creative Commons Attribution-NonCommercial-NoDerivatives (CC BY-NC-ND)", reuse:true, commercial:false, derivatives:false, attribution:true, shareAlike:false, url:"https://creativecommons.org/licenses/by-nc-nd/4.0/"},
  stock_licence:{short:"Stock licence", label:"Stock licence (the provider terms permit this use)", reuse:true, commercial:true, derivatives:true, attribution:false, shareAlike:false, url:null},
  /* Output of an AI tool the operator ran themselves, on their own account. The vendors in play here
     assign the output to the account holder — Anthropic does so explicitly in its Commercial Terms
     ("Customer ... owns its Outputs"; "Anthropic hereby assigns to Customer its right, title and
     interest (if any) in and to Outputs") — so this is the operator's own work. It is cleared exactly
     like `own`: no credit, no permission, nothing to declare. The tool and any terms worth remembering
     are still offered as provenance, because they are useful to record, but they are not a condition
     of use. This app does not audit a vendor's terms and never did: the old warning asked the
     operator to restate them, which is a nudge, not a check. */
  generated:    {short:"AI-generated", label:"AI-generated, my own work (the provider assigns the output to me)", reuse:true, commercial:true, derivatives:true, attribution:false, shareAlike:false, self_owned:true, url:null},
  unknown:      {short:"Not confirmed", label:"Not confirmed", reuse:false, commercial:false, derivatives:false, attribution:false, shareAlike:false, url:null}
};

/* Licences that describe a Creative Commons work: these need the original address recorded, because
   the credit has to point at it. */
const CREDIT_SOURCES = ["cc0","public_domain","cc_by","cc_by_sa","cc_by_nc","cc_by_nd","cc_by_nc_sa","cc_by_nc_nd"];
const BASIS = Object.keys(LICENCES);
const MAX_TEXT = 300;
const UNKNOWN = Object.freeze({basis:"unknown"});

function fail(message, status = 400) { throw Object.assign(new Error(message), {status}); }

function clean(value, limit = MAX_TEXT) {
  if (value === undefined || value === null) return null;
  const text = String(value).replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (!text) return null;
  if (text.length > limit) fail("That value is longer than " + limit + " characters.");
  return text;
}

function httpUrl(value) {
  const text = clean(value, 2000);
  if (!text) return null;
  let url;
  try { url = new URL(text); } catch { fail("Enter the full http or https address of the original."); }
  if (!["http:","https:"].includes(url.protocol) || url.username || url.password) {
    fail("Use an http or https address without embedded credentials.");
  }
  return url.href;
}

function known(basis) { return typeof basis === "string" && Object.hasOwn(LICENCES, basis); }
function licenceFor(basis) { return known(basis) ? LICENCES[basis] : LICENCES.unknown; }
function licenceIds() { return BASIS.slice(); }

/* Whether a library item can end up inside the rendered video, and therefore needs a licence basis.
   A note, a PDF or a URL read for research is not published, so it is not gated: reading a public
   page and writing about it is not copying it into a video, and demanding a licence for it would
   train people to click through the gate without reading it. A file whose own type is visual or
   audio, or anything filed under media or brand, is gated. This mirrors the storyboard catalogue, so
   the two cannot disagree about what is eligible for the video. */
const PUBLISHABLE_MIME = /^(video|image|audio)\//;
function publishable(asset) {
  if (!asset) return false;
  if (asset.category === "media" || asset.category === "brand") return true;
  return asset.kind === "file" && PUBLISHABLE_MIME.test(String(asset.mime || ""));
}

/* Licence identifiers as Creative Commons, Openverse and Archive.org write them, mapped onto this
   app's ids. Anything not recognised maps to "unknown", which the gate blocks, so a licence this
   code has never seen can never be treated as permission. */
const CC_CODES = {
  cc0: "cc0", zero: "cc0",
  pdm: "public_domain", mark: "public_domain", pd: "public_domain", publicdomain: "public_domain", public_domain: "public_domain",
  by: "cc_by", by_sa: "cc_by_sa", by_nc: "cc_by_nc", by_nd: "cc_by_nd",
  by_nc_sa: "cc_by_nc_sa", by_nc_nd: "cc_by_nc_nd"
};

function creativeCommonsBasis(value) {
  let code = String(value === undefined || value === null ? "" : value).trim().toLowerCase();
  if (!code) return "unknown";
  // Accepts a full licence address as well as a bare code: ".../licenses/by-nc-nd/4.0/".
  const fromUrl = code.match(/creativecommons\.org\/(?:licenses|publicdomain)\/([a-z0-9-]+)/);
  if (fromUrl) code = fromUrl[1];
  code = code.replace(/[-_ ]/g, "_");
  // Tried before stripping a "cc" prefix, because "cc0" would otherwise be reduced to "0".
  if (Object.hasOwn(CC_CODES, code)) return CC_CODES[code];
  const stripped = code.replace(/^cc_?/, "");
  if (Object.hasOwn(CC_CODES, stripped)) return CC_CODES[stripped];
  if (known(code)) return code;
  return known(stripped) ? stripped : "unknown";
}

/* Accepts a stored record, a half-filled one, or nothing at all, and always returns the same shape.
   Nothing here throws: an unrecognised record becomes "not confirmed" so it fails closed. */
function normalise(record) {
  const source = record && typeof record === "object" ? record : {};
  return {
    basis: known(source.basis) ? source.basis : "unknown",
    title: clean(source.title),
    holder: clean(source.holder),
    source_url: clean(source.source_url, 2000),
    licence_url: clean(source.licence_url, 2000),
    note: clean(source.note, 1000),
    recorded_at: clean(source.recorded_at, 40)
  };
}

/* Validates what the operator typed. A licence that legally requires a credit cannot be recorded
   without the one element that credit cannot work without: somewhere to point. The creator and title
   are asked for but not demanded, because a licence only obliges you to credit a creator the licensor
   actually supplied, and plenty of sources supply none. */
function validateRights(body) {
  if (!body || typeof body !== "object") fail("A rights record is required.");
  const basis = String(body.basis === undefined || body.basis === null ? "" : body.basis);
  if (!known(basis)) fail("Choose what the rights basis is.");
  if (basis === "unknown") return {...UNKNOWN};

  const licence = LICENCES[basis];
  const record = {
    basis,
    title: clean(body.title),
    holder: clean(body.holder),
    source_url: body.source_url ? httpUrl(body.source_url) : null,
    note: clean(body.note, 1000),
    licence_url: licence.url
  };
  if (basis === "permission") {
    if (!record.holder) fail("Record who granted permission.");
    if (!record.note && !record.source_url) fail("Record how permission was given, or the message or page it came from.");
  }
  if (CREDIT_SOURCES.includes(basis) && !record.source_url) {
    fail("Record where this came from, so the credit can point at the original.");
  }
  if (licence.attribution && !record.source_url) {
    fail("This licence requires a credit that links to the original. Record where it came from.");
  }
  return record;
}

/* The credit line the exports must carry, or null when the licence needs no credit.
   Shaped after what Creative Commons actually requires: the licence, and a link to the material.
   The creator is named when the source supplied one, and the credit points at the source when it
   did not, which is how an unsupplied name is handled correctly rather than invented. */
function attributionFor(record) {
  const item = normalise(record);
  const licence = licenceFor(item.basis);
  if (!licence.attribution) return null;
  const credit = (item.title ? '"' + item.title + '"' : 'Untitled work') + (item.holder ? " by " + item.holder : "");
  const terms = licence.label.replace(/\s*\(.*\)$/, "") + (licence.url ? " (" + licence.url + ")" : "");
  return [credit, terms, item.source_url].filter(Boolean).join(" \u2014 ");
}

/* The decision for one item. Blocked means it must not reach a render; warning means it can, but
   something about it must appear in the finished work (a credit, or a matching licence). */
function assessRights(record, options) {
  const opts = options || {};
  const monetised = opts.commercial !== false;
  const item = normalise(record);
  const licence = licenceFor(item.basis);
  const reasons = [];
  const warnings = [];
  const attribution = attributionFor(item);

  if (!licence.reuse) {
    reasons.push("Rights are not confirmed. Record where this came from and its licence before it can be used.");
  } else {
    if (monetised && !licence.commercial) {
      reasons.push("This licence forbids commercial use, and this video is monetised. Replace it, or record a licence that permits it.");
    }
    if (!licence.derivatives) {
      reasons.push("This licence forbids derivative works, so the material cannot be trimmed or cut into a new video.");
    }
    // Checked against the record, not the rendered line: the line always renders something, so
    // testing it would let an unattributable licence through as merely a warning. Only the link is
    // required, because a licence obliges you to credit a creator the licensor actually supplied.
    if (licence.attribution && !item.source_url) {
      reasons.push("This licence requires a credit that links to the original, but no source address was recorded.");
    }
    if (licence.attribution && item.source_url && !item.holder) {
      warnings.push("The source supplied no creator name, so the credit names the work and links to the original instead.");
    }
    if (licence.shareAlike) warnings.push("ShareAlike: the finished video must itself be published under the same licence.");
    if (licence.attribution) warnings.push("Attribution required. The credit is written into the export metadata automatically.");
  }

  return {
    state: reasons.length ? "blocked" : (warnings.length ? "warning" : "cleared"),
    basis: item.basis,
    label: licence.label,
    short: licence.short,
    self_owned: !!licence.self_owned,
    reasons,
    warnings,
    attribution,
    attribution_required: !!licence.attribution,
    share_alike: !!licence.shareAlike,
    commercial_allowed: !!licence.commercial,
    derivatives_allowed: !!licence.derivatives
  };
}

/* The gate over everything headed for the video. canRender is the single answer the composer and
   the QC report both consult, so they cannot disagree about whether the material may be used. */
function rightsGate(items, options) {
  const cleared = [], blocked = [], warned = [], attributions = [];
  for (const item of items || []) {
    const assessment = assessRights(item && item.rights, options);
    const record = Object.assign({id: (item && item.id) || null, name: (item && item.name) || (item && item.id) || "unnamed item"}, assessment);
    if (assessment.attribution && !attributions.includes(assessment.attribution)) attributions.push(assessment.attribution);
    if (assessment.state === "blocked") blocked.push(record);
    else {
      cleared.push(record);
      if (assessment.state === "warning") warned.push(record);
    }
  }
  return {
    cleared,
    blocked,
    warnings: warned,
    attributions,
    can_render: blocked.length === 0,
    summary: {total: cleared.length + blocked.length, cleared: cleared.length, blocked: blocked.length, warnings: warned.length}
  };
}

/* A short human sentence naming what is blocked, for a 409 or a QC report. */
function blockedSentence(blocked, limit = 3) {
  const items = (blocked || []).slice(0, limit);
  if (!items.length) return "";
  const named = items.map(item => item.name + " (" + (item.reasons[0] || "rights not confirmed") + ")");
  const extra = blocked.length > items.length ? " and " + (blocked.length - items.length) + " more" : "";
  return named.join("; ") + extra + ".";
}

module.exports = {LICENCES, licenceIds, licenceFor, creativeCommonsBasis, publishable, normalise, validateRights, attributionFor, assessRights, rightsGate, blockedSentence};