/**
 * GitHub-only private synchronization for UYFund Management System.
 * The static site may be public; ALL state and document bytes stay in a PRIVATE repository.
 * A fine-grained Contents read/write token is held in memory only and never committed.
 */
export const GITHUB_REPO = 'zvuk71/uyfund-management';
export const GITHUB_BRANCH = 'uyfund-data';
export const GITHUB_STATE_PATH = 'private-data/state.json';
export const GITHUB_FILE_PREFIX = 'private-data/files/';
export const MAX_FILE_BYTES = 20 * 1024 * 1024; // conservative browser/API memory cap

const enc = new TextEncoder();
const dec = new TextDecoder();

export function bytesToBase64(bytes) {
  const parts = [];
  for (let i = 0; i < bytes.length; i += 32768) {
    const chunk = bytes.subarray(i, i + 32768);
    let binary = '';
    for (let j = 0; j < chunk.length; j++) binary += String.fromCharCode(chunk[j]);
    parts.push(binary);
  }
  return btoa(parts.join(''));
}
export function base64ToBytes(base64) {
  const binary = atob(String(base64).replace(/\s/g, ''));
  const result = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) result[i] = binary.charCodeAt(i);
  return result;
}
export const jsonToBase64 = value => bytesToBase64(enc.encode(JSON.stringify(value, null, 2) + '\n'));
export const base64ToJson = base64 => JSON.parse(dec.decode(base64ToBytes(base64)));

export class GitHubError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'GitHubError';
    this.status = status;
  }
}

export class GitHubStorage {
  constructor(token, fetchImpl = fetch, repo = GITHUB_REPO, branch = GITHUB_BRANCH) {
    if (!token || /\s/.test(token)) throw new Error('Вкажіть GitHub fine-grained token.');
    this.token = token;
    this.fetchImpl = fetchImpl;
    this.repo = repo;
    this.branch = branch;
    this.stateSha = null;
  }
  async request(path, {method = 'GET', data, headers = {}} = {}) {
    if (!path.startsWith('/')) throw new Error('Некоректний шлях GitHub API.');
    const response = await this.fetchImpl(`https://api.github.com${path}`, {
      method,
      headers: {
        'Accept': 'application/vnd.github+json',
        'Authorization': `Bearer ${this.token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        ...(data === undefined ? {} : {'Content-Type': 'application/json'}),
        ...headers,
      },
      ...(data === undefined ? {} : {body: JSON.stringify(data)}),
      cache: 'no-store',
    });
    let body = null;
    try {body = await response.json();} catch {}
    if (!response.ok) {
      let message = body?.message || `GitHub API: HTTP ${response.status}`;
      if (response.status === 401) message = 'GitHub відхилив токен. Перевірте термін дії та права доступу.';
      if (response.status === 403) message = 'GitHub заборонив доступ: перевірте Contents: Read and write або ліміт запитів.';
      if (response.status === 409 || response.status === 422) message = 'Інший пристрій змінив дані. Оновіть стан із GitHub перед наступним редагуванням.';
      throw new GitHubError(response.status, message);
    }
    return body;
  }
  repoPath(path) {return `/repos/${this.repo}/${path}`;}
  contentsPath(path) {return this.repoPath(`contents/${path}`);}
  async checkPrivateAccess() {
    const repo = await this.request(`/repos/${this.repo}`);
    if (!repo.private) throw new Error('Репозиторій не приватний. Завантаження конфіденційних документів заблоковано.');
    const branch = await this.request(this.repoPath(`branches/${encodeURIComponent(this.branch)}`));
    if (!branch.commit?.sha) throw new Error('Гілка для даних не знайдена. Потрібно створити uyfund-data.');
    return repo;
  }
  async getContents(path) {
    return this.request(`${this.contentsPath(path)}?ref=${encodeURIComponent(this.branch)}`);
  }
  async readState() {
    const result = await this.getContents(GITHUB_STATE_PATH);
    if (!result.sha) throw new Error('GitHub не повернув версію бази.');
    this.stateSha = result.sha;
    let state;
    if (result.content && result.encoding === 'base64') state = base64ToJson(result.content);
    else if (result.git_url) {
      const blob = await this.request(this.repoPath(`git/blobs/${result.sha}`));
      state = base64ToJson(blob.content);
    } else throw new Error('Не вдалося прочитати базу з GitHub.');
    if (!state || !Array.isArray(state.grants) || !Array.isArray(state.projects)) throw new Error('Некоректна структура бази в GitHub.');
    return state;
  }
  async saveState(state) {
    if (!this.stateSha) throw new Error('Спочатку потрібно завантажити базу з GitHub.');
    const result = await this.request(this.contentsPath(GITHUB_STATE_PATH), {
      method: 'PUT',
      data: {
        message: `UYFund: синхронізація записів ${new Date().toISOString()}`,
        content: jsonToBase64(state),
        branch: this.branch,
        sha: this.stateSha,
      },
    });
    if (!result.content?.sha) throw new Error('GitHub не підтвердив збереження бази.');
    this.stateSha = result.content.sha;
    return this.stateSha;
  }
  static filePath(id) {
    if (!/^[a-zA-Z0-9_-]{1,120}$/.test(String(id))) throw new Error('Некоректний ідентифікатор файлу.');
    return GITHUB_FILE_PREFIX + id;
  }
  async uploadFile(id, blob, filename) {
    if (!blob || blob.size > MAX_FILE_BYTES) throw new Error('Файл завеликий для GitHub-режиму (максимум 20 МБ).');
    const path = GitHubStorage.filePath(id);
    const content = bytesToBase64(new Uint8Array(await blob.arrayBuffer()));
    let existingSha = null;
    try {existingSha = (await this.getContents(path)).sha;}
    catch(error) {if (error.status !== 404) throw error;}
    const result = await this.request(this.contentsPath(path), {
      method: 'PUT',
      data: {
        message: `UYFund: документ ${String(filename || id).slice(0, 100)}`,
        content,
        branch: this.branch,
        ...(existingSha ? {sha: existingSha} : {}),
      },
    });
    if (!result.content?.sha) throw new Error('GitHub не підтвердив завантаження документа.');
    return result.content.sha;
  }
  async downloadFile(id, sha, mime = 'application/octet-stream') {
    if (!sha || !/^[a-f0-9]{40}$/.test(sha)) {
      const result = await this.getContents(GitHubStorage.filePath(id));
      sha = result.sha;
    }
    const blob = await this.request(this.repoPath(`git/blobs/${sha}`));
    if (blob.encoding !== 'base64' || !blob.content) throw new Error('GitHub не повернув оригінал файлу.');
    return new Blob([base64ToBytes(blob.content)], {type: mime});
  }
  async deleteFile(id) {
    const path = GitHubStorage.filePath(id);
    let file;
    try {file = await this.getContents(path);} catch (error) {if (error.status === 404) return; throw error;}
    await this.request(this.contentsPath(path), {
      method: 'DELETE',
      data: {message: `UYFund: видалення документа ${id}`, branch: this.branch, sha: file.sha},
    });
  }
  disconnect() {this.token = '';this.stateSha = null;}
}