const fs = require('fs');
const path = require('path');

/**
 * Minimal EJS-like renderer supporting <% code %> and <%= expr %>
 */
function renderTemplate(template, data) {
  const escapeBackticks = s => s.replace(/\\/g, '\\\\').replace(/`/g, '\\`');
  let code = 'let __out = ``;\nwith(data) {\n';
  let cursor = 0;
  const re = /<%([=-]?)([\s\S]*?)%>/g;
  let match;

  while ((match = re.exec(template)) !== null) {
    code += `__out += \`${escapeBackticks(template.slice(cursor, match.index))}\`;\n`;
    if (match[1] === '=') {
      code += `__out += (${match[2].trim()});\n`;
    } else {
      code += `${match[2]}\n`;
    }
    cursor = match.index + match[0].length;
  }

  code += `__out += \`${escapeBackticks(template.slice(cursor))}\`;\n}\nreturn __out;`;
  return new Function('data', code)(data);
}

/**
 * Escape markdown special characters in text
 */
function escapeMarkdown(text) {
  return text
    .replace(/\r?\n/g, ' ')
    .replace(/\[|\]/g, '\\$&')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/`/g, '\\`')
    .replace(/\*/g, '\\*')
    .replace(/_/g, '\\_')
    .replace(/~/g, '\\~')
    .replace(/#/g, '\\#');
}

/**
 * Convert language name to valid anchor ID
 */
function toAnchorId(text) {
  return text
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^\w-]+/g, '')
    .replace(/-+/g, '-');
}

/**
 * Retry helper with exponential backoff
 */
async function withRetry(fn, retries = 3, delay = 1000) {
  try {
    return await fn();
  } catch (error) {
    if (retries <= 0) throw error;

    // Handle rate limit headers if present
    let retryAfter = delay;
    if (error.response?.headers?.['retry-after']) {
      retryAfter = parseInt(error.response.headers['retry-after'], 10) * 1000;
    }

    console.warn(`Request failed, retrying in ${retryAfter}ms (${retries} left)...`, error.message);
    await new Promise(resolve => setTimeout(resolve, retryAfter));
    return withRetry(fn, retries - 1, delay * 2);
  }
}

/**
 * Fetch all starred repos for a user
 */
async function fetchStarredRepos(user, token) {
  const repos = [];
  const maxPages = 100; // Prevent infinite loops

  for (let page = 1; page <= maxPages; page += 1) {
    const url = `https://api.github.com/users/${user}/starred?per_page=100&page=${page}`;
    const response = await withRetry(() => fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': `${user}-awesome-stars-workflow`,
      },
    }));

    if (!response.ok) {
      throw new Error(`GitHub API ${response.status}: ${await response.text()}`);
    }

    const items = await response.json();
    if (!items.length) {
      break;
    }

    repos.push(...items);

    if (items.length < 100) {
      break;
    }
  }

  return repos;
}

/**
 * Group repos by language and prepare template data
 */
function processRepos(repos) {
  const map = new Map();

  for (const repo of repos) {
    const language = repo.language || 'Unknown';
    if (!map.has(language)) {
      map.set(language, []);
    }
    map.get(language).push(repo);
  }

  const entries = Array.from(map.entries()).sort(([a], [b]) => a.localeCompare(b));
  const reposByLanguage = entries.map(([language, items]) => ({
    language,
    anchorId: toAnchorId(language),
    repos: items.sort((a, b) => a.full_name.localeCompare(b.full_name)).map(repo => ({
      ...repo,
      description: repo.description ? escapeMarkdown(repo.description) : ''
    }))
  }));

  return {
    languages: reposByLanguage.map(g => g.language),
    languageAnchors: reposByLanguage.map(g => g.anchorId),
    reposByLanguage
  };
}

async function main() {
  const token = process.env.API_TOKEN;
  const user = process.env.GITHUB_USER;
  const templatePath = path.resolve(process.env.TEMPLATE_PATH || 'template/README.ejs');
  const readmePath = path.resolve('README.md');
  const dataPath = path.resolve('data.json');

  if (!token) {
    throw new Error('Missing API_TOKEN secret. GITHUB_TOKEN does not have permission to read your starred repositories.');
  }

  if (!user) {
    throw new Error('Missing GITHUB_USER environment variable.');
  }

  console.log(`Fetching starred repos for ${user}...`);
  const repos = await fetchStarredRepos(user, token);
  console.log(`Fetched ${repos.length} starred repos`);

  const { languages, languageAnchors, reposByLanguage } = processRepos(repos);

  // Generate data.json
  const data = {
    generatedAt: new Date().toISOString(),
    user,
    repos,
    languages,
    reposByLanguage
  };
  fs.writeFileSync(dataPath, JSON.stringify(data, null, 2) + '\n');
  console.log('data.json updated');

  // Render README from template
  const template = fs.readFileSync(templatePath, 'utf8');
  const readme = renderTemplate(template, {
    username: user,
    stars: reposByLanguage,
    languages,
    languageAnchors
  });

  // Only update if changed
  const currentReadme = fs.readFileSync(readmePath, 'utf8');
  if (currentReadme !== readme) {
    fs.writeFileSync(readmePath, readme);
    console.log('README.md updated');
  } else {
    console.log('README.md unchanged');
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
