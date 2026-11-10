/**
 * Standalone RSS & JSON Feed generator for GitHub Actions
 */

const fs = require('fs');
const path = require('path');

const SITE_URL = 'https://kontentferma.com';
const FEED_TITLE = 'Блог и кейсы «Контент Фермы» | Маркетинг, SMM, Стратегия и AI-контент';
const FEED_DESC = 'Практические кейсы, статьи и руководства по контент-маркетингу, SMM, SEO и автоматизации контента от Контент Фермы.';
const FEED_LANG = 'ru-RU';

const queueFile = path.join(__dirname, 'queue.json');
const imageCdnMapFile = path.join(__dirname, 'image_cdn_map.json');

const imageCdnMap = fs.existsSync(imageCdnMapFile)
  ? JSON.parse(fs.readFileSync(imageCdnMapFile, 'utf8'))
  : {};

function xmlEscape(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function coverImageFor(item, body) {
  // Articles use the numbered source cover name in image_cdn_map.json.
  if (item.type !== 'CASE' && item.articleId) {
    const key = `cover_${String(item.articleId).padStart(2, '0')}_${item.slug}.png`;
    if (imageCdnMap[key]) return imageCdnMap[key];
  }

  // Cases (and any future article without a numbered mapping) use their first
  // Markdown image, which is the cover in the source files.
  const firstImage = body.match(/^!\[[^\]]*\]\(([^)]+)\)/m);
  if (!firstImage) return '';

  const source = firstImage[1];
  if (/^https?:\/\//i.test(source)) return source;
  return imageCdnMap[source] || imageCdnMap[path.basename(source)] || '';
}

function parseMarkdownFrontmatter(content) {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  const data = {};
  let body = content;

  if (fmMatch) {
    const lines = fmMatch[1].split('\n');
    body = fmMatch[2];
    for (const l of lines) {
      const idx = l.indexOf(':');
      if (idx !== -1) {
        const k = l.slice(0, idx).trim();
        let v = l.slice(idx + 1).trim();
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
          v = v.slice(1, -1);
        }
        data[k] = v;
      }
    }
  }

  let descr = data.descr || data.description || '';
  if (!descr) {
    const pMatch = body.replace(/<[^>]+>/g, ' ').replace(/^#.+$/gm, '').replace(/!\[.*?\]\(.*?\)/g, '').trim().split('\n\n');
    descr = pMatch[0] ? pMatch[0].replace(/\s+/g, ' ').slice(0, 300).trim() : '';
  }

  return { frontmatter: data, descr, body };
}

function generateRss() {
  if (!fs.existsSync(queueFile)) {
    console.error('queue.json not found');
    process.exit(1);
  }

  const queue = JSON.parse(fs.readFileSync(queueFile, 'utf8'));
  const now = new Date();

  // Filter items where scheduled date has arrived
  const publishedItems = queue.filter(item => {
    if (!item.postuid) return false;
    const itemDate = new Date(item.scheduledIso || item.publishedAt || 0);
    return itemDate <= now;
  });

  publishedItems.sort((a, b) => {
    const da = new Date(a.scheduledIso || a.publishedAt || 0).getTime();
    const db = new Date(b.scheduledIso || b.publishedAt || 0).getTime();
    return db - da;
  });

  console.log(`[RSS] Found ${publishedItems.length} active items at ${now.toISOString()}`);

  const feedItems = [];
  const jsonFeedItems = [];

  for (const item of publishedItems) {
    const isCase = item.type === 'CASE';
    const candidateFiles = [
      path.join(__dirname, `${item.slug}.md`),
      path.join(__dirname, `${String(item.articleId || item.caseId).padStart(2, '0')}_${item.slug}.md`)
    ];

    let descr = '';
    let author = 'Редакция Контент Фермы';
    let body = '';

    for (const f of candidateFiles) {
      if (fs.existsSync(f)) {
        const raw = fs.readFileSync(f, 'utf8');
        const parsed = parseMarkdownFrontmatter(raw);
        descr = parsed.descr;
        body = parsed.body;
        if (parsed.frontmatter.author) author = parsed.frontmatter.author;
        break;
      }
    }

    const pubDateStr = new Date(item.scheduledIso || item.publishedAt).toUTCString();
    const liveUrl = item.liveUrl || `${SITE_URL}${isCase ? '/cases/' : '/blog/'}${item.postuid}-${item.slug}`;
    const coverImage = coverImageFor(item, body);
    const coverXml = coverImage
      ? `\n      <enclosure url="${xmlEscape(coverImage)}" length="0" type="image/png"/>\n      <media:content url="${xmlEscape(coverImage)}" medium="image"/>\n      <media:thumbnail url="${xmlEscape(coverImage)}"/>`
      : '';

    feedItems.push(`    <item>
      <title><![CDATA[${item.title}]]></title>
      <link>${liveUrl}</link>
      <guid isPermaLink="true">${liveUrl}</guid>
      <description><![CDATA[${descr}]]></description>
      <pubDate>${pubDateStr}</pubDate>
      <author>${author}</author>
      <category>${item.partitionName || (isCase ? 'Кейсы' : 'Маркетинг')}</category>${coverXml}
    </item>`);

    jsonFeedItems.push({
      id: liveUrl,
      url: liveUrl,
      title: item.title,
      summary: descr,
      date_published: new Date(item.scheduledIso || item.publishedAt).toISOString(),
      author: { name: author },
      tags: [item.partitionName || (isCase ? 'Кейсы' : 'Маркетинг')],
      ...(coverImage ? { image: coverImage } : {})
    });
  }

  const buildDate = now.toUTCString();
  const rssXml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:media="http://search.yahoo.com/mrss/">
  <channel>
    <title>${FEED_TITLE}</title>
    <link>${SITE_URL}/blog</link>
    <description>${FEED_DESC}</description>
    <language>${FEED_LANG}</language>
    <lastBuildDate>${buildDate}</lastBuildDate>
    <atom:link href="${SITE_URL}/blog/rss.xml" rel="self" type="application/rss+xml"/>
${feedItems.join('\n')}
  </channel>
</rss>`;

  const jsonFeed = {
    version: 'https://jsonfeed.org/version/1.1',
    title: FEED_TITLE,
    home_page_url: `${SITE_URL}/blog`,
    feed_url: `${SITE_URL}/blog/feed.json`,
    description: FEED_DESC,
    items: jsonFeedItems
  };

  fs.writeFileSync(path.join(__dirname, 'rss.xml'), rssXml, 'utf8');
  fs.writeFileSync(path.join(__dirname, 'feed.json'), JSON.stringify(jsonFeed, null, 2), 'utf8');
  console.log(`[RSS] Updated rss.xml and feed.json with ${publishedItems.length} items.`);
}

generateRss();
