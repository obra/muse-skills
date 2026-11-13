import datetime, json, os, re, subprocess, sys, urllib.request
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor as Pool
from zoneinfo import ZoneInfo
IG = ["/opt/hatch/bin/instagram-cli"]
FB = ["/opt/hatch/bin/facebook-cli"]
SHORTCODE_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
STATE = os.path.expanduser("~/workspace/instagram-daily/state.json")
MEDIA = os.path.expanduser("~/workspace/instagram-daily/media")
UTC = datetime.timezone.utc
day = lambda n: str(datetime.date.today() - datetime.timedelta(days=n))
def cli(base, *args):
    try: return json.loads(subprocess.run(base + list(args), capture_output=True, text=True).stdout)
    except ValueError: return {}
ig = lambda *a: cli(IG, *a)
fb = lambda *a: cli(FB, *a)
def run_all(*calls):
    if not calls: return []
    with Pool(min(len(calls), 12)) as pool: return list(pool.map(lambda f: f(), calls))
def media_id(p):
    i = p.get("post_id") or (p.get("media") or {}).get("media_id")
    if i: return str(i).split("_")[0]
    code, n = (p.get("url") or "").rstrip("/").split("/")[-1], 0
    if not code or set(code) - set(SHORTCODE_ALPHABET): return None
    for c in code: n = n * 64 + SHORTCODE_ALPHABET.index(c)
    return str(n)
def posts(a, days=None): return ig("posts", "--account-id", a, "--limit", "50", *(["--since", day(days)] if days else [])).get("posts") or []
def score(p): return (p["likes"] or 0) + (p["comments"] or 0)
def avg(ps): return round(sum(map(score, ps)) / len(ps)) if ps else None
def kind(r):
    t, mt = (r.get("post_type") or "").lower(), (r.get("media_type") or "").lower()
    if t in ("reel", "clips") or "reel" in mt: return "reel"
    if r.get("children") or "carousel" in mt or "album" in mt: return "carousel"
    return "video" if "video" in mt else "photo"
def fb_kind(t):
    t = (t or "").lower()
    return ("reel" if "reel" in t else "video" if "video" in t else "carousel" if "album" in t or "multi" in t
            else "photo" if "photo" in t else "link" if "share" in t or "link" in t else "text")
def when(s):
    if not s: return None
    t = datetime.datetime.fromisoformat(str(s).replace(" ", "T").replace("Z", "+00:00").replace("+0000", "+00:00"))
    return t if t.tzinfo else t.replace(tzinfo=UTC)
def zone(name):
    try: return ZoneInfo(name or "UTC")
    except Exception: return UTC
def number(s):
    m = re.match(r"\s*([\d.,]+)\s*([KkMm]?)", str(s or ""))
    return int(float(m.group(1).replace(",", "")) * {"k": 1e3, "m": 1e6}.get(m.group(2).lower(), 1)) if m else None
def field(items, name):
    x = next((x for x in items or [] if x.get("field") == name), {})
    return x.get("value") if x.get("value") is not None else number(x.get("rendered_text"))
def daypart(h): return "night" if h < 5 or h >= 22 else "morning" if h < 11 else "midday" if h < 16 else "evening"
def post(i, at, fmt, caption, likes, comments, shows):
    return {"id": i, "date": at.strftime("%Y-%m-%d") if at else "", "weekday": at.strftime("%A") if at else None,
            "posted_at": at.strftime("%-I %p") if at else None, "daypart": daypart(at.hour) if at else None, "format": fmt,
            "caption": (caption or "")[:300], "likes": likes, "comments": comments, "shows": shows}
def local(s, tz):
    try: at = when(s); return at.astimezone(tz) if at else None
    except ValueError: return None
def by(ps, key):
    groups = defaultdict(list)
    for p in ps:
        if key(p) is not None: groups[key(p)].append(p)
    return {k: {"posts": len(v), "avg_likes_and_comments": avg(v)} for k, v in groups.items()}
def summarize(base, found, said):
    found.sort(key=lambda p: p["date"], reverse=True)
    ranked = sorted(found, key=score, reverse=True)
    said = said(ranked[:3]) if callable(said) else said
    for p in ranked[:3]: p["what_commenters_said"] = said.get(p["id"], [])
    newest = next((p["date"] for p in found if p["date"]), None)
    out = {**base, "posts_analyzed": len(found), "avg_likes_and_comments": avg(found), "too_little_to_compare": len(found) < 5 or (avg(found) or 0) < 10,
           "days_since_last_post": (datetime.date.today() - datetime.date.fromisoformat(newest)).days if newest else None,
           "recent_captions": [p["caption"] for p in found if p["caption"]][:5], "top_posts": ranked[:3], "weakest_posts": ranked[3:][-2:], "posts": found}
    if not out["too_little_to_compare"]:
        out.update(by_format=by(found, lambda p: p["format"]), by_time_of_day=by(found, lambda p: p["daypart"]),
                   by_caption=by(found, lambda p: "asks a question" if "?" in p["caption"] else "no question"))
    return out
def ig_comments(a):
    def said(top):
        out = {}
        if not top: return out
        for g in ig("fetch-post-comments", "--account-id", a, "--post-ids", ",".join(p["id"] for p in top), "--limit", "10").get("post_groups") or []:
            texts = [(c.get("text") or c.get("comment_text") or c.get("body") or "")[:150] for c in g.get("comments") or []]
            out[(g.get("media") or {}).get("media_id")] = [t for t in texts if t]
        return out
    return said
def read_ig(acct):
    a, name = acct["user_fbid"], acct.get("username")
    prof, d30, d7, arch = run_all(lambda: ig("profile", "--account-id", a), lambda: posts(a, 30), lambda: posts(a, 7),
                                  lambda: ig("own-stories-archive", "--account-id", a))
    tz = zone((prof.get("retrieved_at") or {}).get("user_timezone"))
    prof = (prof.get("profiles") or [{}])[0]
    recs = {}
    for p in (d30 if len(d30) >= 3 else posts(a))[:30]:
        i = media_id(p)
        if i: recs[i] = {"created_at": p.get("created_at"), "caption": p.get("post_caption"), "likes": p.get("likes"),
                         "comments": p.get("comments"), "media_type": p.get("media_type"), "picture": p.get("thumbnail_url")}
    # Stories from the last 30 days. Instagram keeps a Story's viewer count for 48 hours, so older ones have none.
    cutoff = datetime.datetime.now(UTC) - datetime.timedelta(days=30)
    stories, pictures = [], {i: r["picture"] for i, r in recs.items() if r.get("picture")}
    for st in arch.get("stories") or []:
        at = datetime.datetime.fromtimestamp(st["created_at"], UTC) if isinstance(st.get("created_at"), (int, float)) else when(st.get("created_at"))
        media = (st.get("media") or [{}])[0]
        if at and at >= cutoff and media.get("id"):
            if media.get("image_url"): pictures[str(media["id"])] = media["image_url"]
            stories.append({"id": str(media["id"]), "date": at.astimezone(tz).strftime("%Y-%m-%d"), "viewers": st.get("viewer_count"),
                            "format": "video" if "video" in str(media.get("media_type")).lower() or str(media.get("media_type")) == "2" else "photo"})
    told = sorted(stories, key=lambda x: (x["viewers"] is not None, x["viewers"] or 0, x["date"]), reverse=True)[:3]
    by_story = {x["id"]: x for x in told}
    ids = list(recs) + [i for i in by_story if i not in recs]
    for item in (ig("media-understanding", "--account-id", a, "--media-ids", ",".join(ids)).get("media") or []) if ids else []:
        m = item.get("media") if isinstance(item.get("media"), dict) else item
        if str(m.get("media_id") or "") in by_story:
            by_story[str(m["media_id"])]["shows"] = (m.get("understanding") or {}).get("core_insight") or (m.get("narrative_summary") or "")[:220] or None
        r = recs.get(str(m.get("media_id") or "")); c = m.get("interactions") or {}
        if r is None: continue
        for k, v in (("created_at", m.get("created_at")), ("caption", m.get("caption")), ("likes", c.get("like_count")),
                     ("comments", c.get("comment_count")), ("media_type", m.get("media_type")), ("post_type", m.get("post_type")), ("children", m.get("children"))):
            if r.get(k) in (None, "") and v not in (None, ""): r[k] = v
        r["shows"] = (m.get("understanding") or {}).get("core_insight") or (m.get("narrative_summary") or "")[:220] or None
    found = [post(i, local(r.get("created_at"), tz), kind(r), r.get("caption"), r.get("likes"), r.get("comments"), r.get("shows")) for i, r in recs.items()]
    base = {"platform": "instagram", "username": name, "label": f"@{name}", "account": name, "account_id": a, "user_id": acct.get("user_igid"),
            "professional": acct.get("is_professional"), "bio": prof.get("bio"), "followers": prof.get("follower_count"), "post_count": prof.get("post_count"),
            "posts_last_30_days": len(d30), "posts_last_7_days": len(d7), "posts_read": "last_30_days" if len(d30) >= 3 else "newest"}
    out = summarize(base, found, ig_comments(a))
    out["stories"] = {"last_30_days": len(stories), "recent": told}
    out["_pictures"] = pictures
    if acct.get("is_professional"):
        ins, cards = run_all(lambda: ig("analytics-account-insights", "--account-id", a, "--time-range", "LAST_28D", "--include-top-content"),
                             lambda: ig("analytics-metric-cards", "--account-id", a, "--username", name, "--timezone", str(tz)))
        acc = (ins.get("accounts") or [{}])[0]
        out["insights_28_days"] = {k: acc.get(k) for k in ("metrics", "prior_period_comparison", "follower_active_times", "views_by_follow_type",
                                                            "views_by_content_type", "follower_growth_delta", "top_content_by_views") if acc.get(k)}
        split = out["insights_28_days"].get("views_by_follow_type") or {}
        f, nf = split.get("followers"), split.get("non_followers")
        if isinstance(f, (int, float)) and isinstance(nf, (int, float)) and f + nf > 0:
            out["insights_28_days"]["views_from_non_followers_pct"] = round(100 * nf / (f + nf))
        mine = {p["id"]: p for p in found}
        top = out["insights_28_days"].get("top_content_by_views") or []
        for t in top:
            p = mine.get(str(t.get("media_id")))
            if p: t.update(format=p["format"], date=p["date"], shows=p["shows"], likes=p["likes"], comments=p["comments"])
        # Stories and older posts in the ranking aren't among the posts read above: describe them in one more call.
        rest = {str(t["media_id"]): t for t in top if t.get("media_id") and "format" not in t}
        for item in (ig("media-understanding", "--account-id", a, "--media-ids", ",".join(rest)).get("media") or []) if rest else []:
            m = item.get("media") if isinstance(item.get("media"), dict) else item
            t = rest.get(str(m.get("media_id") or ""))
            shows = (m.get("understanding") or {}).get("core_insight") or (m.get("narrative_summary") or "")[:220]
            if t is None or not shows: continue
            at = local(m.get("created_at"), tz)
            t.update(format={"STORY": "story", "REELS": "reel", "CAROUSEL": "carousel"}.get(str(t.get("media_product_type")).upper(), "photo"),
                     date=at.strftime("%Y-%m-%d") if at else "", shows=shows)
        out["metric_cards"] = ((cards.get("accounts") or [{}])[0]).get("metric_cards")
    return out
def read_fb(me):
    pid, name = str(me["fb_user_id"]), me.get("name")
    rows = [p for p in fb("timeline", "fetch", "--profile-id", pid, "--limit", "40").get("posts") or [] if p.get("author_id") == p.get("owner_id")]
    tz = zone(((rows or [{}])[0].get("post_created_at") or {}).get("user_timezone"))
    now = datetime.datetime.now(UTC)
    def since(d): return [p for p in rows if (local(p.get("created_at"), tz) or now - datetime.timedelta(days=999)) >= now - datetime.timedelta(days=d)]
    d30, d7 = since(30), since(7)
    pool = (d30 if len(d30) >= 3 else rows)[:15]
    def stats(p):
        r, c = run_all(lambda: fb("post", "reactions", "read", "--post-id", p["post_id"]), lambda: fb("post", "comments", "read", "--post-id", p["post_id"], "--limit", "25"))
        texts = [(x.get("text") or "")[:150] for x in c.get("data") or []]
        return sum(x.get("count") or 0 for x in (r.get("summary") or {}).get("reaction_counts") or []), texts
    found, said = [], {}
    for p, (likes, texts) in zip(pool, run_all(*[lambda p=p: stats(p) for p in pool])):
        found.append(post(p["post_id"], local(p.get("created_at"), tz), fb_kind(p.get("media_type")), p.get("post_caption"), likes, len(texts), (p.get("media_summary") or "")[:220] or None))
        said[p["post_id"]] = [t for t in texts if t][:10]
    base = {"platform": "facebook", "username": name, "label": f"Facebook: {name}", "account": "facebook", "account_id": f"fb:{pid}",
            "professional": None, "bio": None, "followers": None, "posts_last_30_days": len(d30), "posts_last_7_days": len(d7),
            "posts_read": "last_30_days" if len(d30) >= 3 else "newest"}
    return summarize(base, found, said)
def read_page(pg):
    i, name = str(pg["page_id"]), pg.get("name")
    lst = lambda r: fb("pages", "posts", "list", "--page-id", i, "--fields", "engagements,saves", "--limit", "25", "--time-range", r).get("results") or []
    rows, ins = run_all(lambda: lst("LAST_28D"), lambda: fb("pages", "account-insights", "--page-id", i, "--metrics", "follower_count,new_followers", "--time-range", "LAST_28D"))
    d28 = len(rows)
    if d28 < 3: rows = lst("LAST_90D")
    found = []
    for r in rows:
        meta = r.get("metadata") or {}
        p = post(str(r.get("object_id")), None, None, meta.get("caption_excerpt"), field(r.get("activity"), "reactions"), field(r.get("activity"), "comment_count"), None)
        p.update(posted_at=meta.get("metadata_text"), saves=field(r.get("metrics"), "saves"))
        found.append(p)
    def said(top):
        got = run_all(*[lambda p=p: fb("post", "comments", "read", "--post-id", p["id"], "--limit", "10").get("data") or [] for p in top])
        return {p["id"]: [(x.get("text") or "")[:150] for x in c if x.get("text")] for p, c in zip(top, got)}
    acc = ((ins.get("results") or [{}])[0]).get("metrics")
    base = {"platform": "facebook_page", "username": name, "label": f"Facebook Page: {name}", "account": f"page:{i}", "account_id": f"page:{i}",
            "professional": True, "bio": None, "followers": field(acc, "follower_count"), "new_followers_28_days": field(acc, "new_followers"),
            "posts_last_30_days": d28, "posts_last_7_days": None, "posts_read": "last_28_days" if d28 >= 3 else "last_90_days"}
    return summarize(base, found, said)
igs, me, pages = run_all(lambda: ig("accounts").get("accounts") or [], lambda: fb("me"), lambda: fb("pages", "list"))
cands = ([(a["user_fbid"], a.get("username"), f"@{a.get('username')}", lambda a=a: read_ig(a)) for a in igs]
         + ([(f"fb:{me['fb_user_id']}", "facebook", "my Facebook profile", lambda: read_fb(me))] if me.get("fb_user_id") else [])
         + [(f"page:{p['page_id']}", f"page:{p['page_id']}", p.get("name") or "Facebook", lambda p=p: read_page(p)) for p in (pages.get("data") or [])[:3]])
if not cands: sys.exit(print(json.dumps({"connected": False})))
state = json.load(open(STATE)) if os.path.exists(STATE) else {}
want = sys.argv[sys.argv.index("--account") + 1].lstrip("@").lower() if "--account" in sys.argv else None
saved = None if "--new" in sys.argv else state.get("account_id")
# --platform: the platform a starter card names, if any. Its accounts are picked first.
prefer = sys.argv[sys.argv.index("--platform") + 1] if "--platform" in sys.argv else None
match = [c for c in cands if (want and want in (c[0].lower(), str(c[1]).lower(), c[2].lower())) or (not want and c[0] == saved)]
pro_ig = any(a.get("is_professional") for a in igs)
found = run_all(*[c[3] for c in match or [c for c in cands if not (pro_ig and c[1] == "facebook" and prefer != "facebook")]])
def rank(f): return (bool(prefer and f["platform"].startswith(prefer) and f["posts"]), bool(f["professional"] and f["posts"]),
                    bool(f["posts_last_30_days"]), f["platform"] == "instagram", f["posts_last_30_days"] or 0, sum(map(score, f["posts"])))
pick = max(found, key=rank)
# Other accounts in the same order: the accounts read here by rank, then the ones not read.
ranks = {f["account_id"]: rank(f) for f in found}
others = sorted((c for c in cands if c[0] != pick["account_id"]), key=lambda c: (c[0] in ranks, ranks.get(c[0], ())), reverse=True)
out = {"connected": True, **pick, "other_accounts": [{"label": c[2], "account": c[1]} for c in others]}
if pages.get("error_reason") == "PROFESSIONAL_CONSENT_REQUIRED": out["facebook_pages"] = "needs_consent"
if state.get("account_id") == pick["account_id"]:
    new = []
    for p in pick["posts"]:
        if p["id"] == state.get("newest_post_id"): break
        if state.get("newest_post_id") or p["date"] >= state.get("date", ""): new.append(p)
    out["since_last_report"] = {"follower_increase": max(0, (pick["followers"] or 0) - (state.get("follower_count") or 0)), "new_posts": new}
    if new and pick["platform"] == "instagram" and pick["professional"]:
        out["since_last_report"]["newest_post_insights"] = ig("individual-post-insights", "--account-id", pick["account_id"], "--post", new[0]["id"])
del out["posts"]
def save_picture(i):
    path = os.path.join(MEDIA, f"{i}.jpg")
    try:
        if not os.path.exists(path):
            os.makedirs(MEDIA, exist_ok=True)
            with urllib.request.urlopen(pictures[i], timeout=10) as r:
                if not (r.headers.get_content_type() or "").startswith("image/"): return None
                data = r.read()
            open(path + ".part", "wb").write(data); os.replace(path + ".part", path)
        return i
    except Exception: return None
# Pictures of the posts and Stories the messages can name, linked as `image` for the chat to show.
pictures = out.pop("_pictures", None) or {}
named = (out.get("top_posts") or [])[:3] + (out.get("stories") or {}).get("recent", []) \
        + [t for t in (out.get("insights_28_days") or {}).get("top_content_by_views") or [] if "format" in t][:3] \
        + (out.get("since_last_report") or {}).get("new_posts", [])[:1]
key = lambda x: str(x.get("id") or x.get("media_id") or "")
saved_pictures = set(run_all(*[lambda i=i: save_picture(i) for i in {key(x) for x in named} & set(pictures)]))
for x in named:
    if key(x) in saved_pictures: x["image"] = f"sandbox://workspace/instagram-daily/media/{key(x)}.jpg"
os.makedirs(os.path.dirname(STATE), exist_ok=True)
json.dump({"account_id": pick["account_id"], "follower_count": pick["followers"], "newest_post_id": (pick["posts"] or [{}])[0].get("id"), "date": day(0)}, open(STATE, "w"))
print(json.dumps(out, ensure_ascii=False))
