// ================= DOM =================
const urlInput = document.getElementById('urlInput');
const analyzeBtn = document.getElementById('analyzeBtn');
const previewArea = document.getElementById('previewArea');
const downloadBtn = document.getElementById('downloadBtn');
const newDownloadBtn = document.getElementById('newDownloadBtn');
const messageArea = document.getElementById('messageArea');
const fileNameEl = document.getElementById('fileName');
const fileSizeEl = document.getElementById('fileSize');
const fileTypeEl = document.getElementById('fileType');
const fileTypeIcon = document.getElementById('fileTypeIcon');

const dropzone = document.getElementById('dropzone');
const fileInput = document.getElementById('fileInput');
const uploadList = document.getElementById('uploadList');
const uploadMessage = document.getElementById('uploadMessage');
const gallery = document.getElementById('gallery');
const galleryEmpty = document.getElementById('galleryEmpty');
const galleryCount = document.getElementById('galleryCount');
const refreshBtn = document.getElementById('refreshBtn');
const tabs = document.querySelectorAll('.tab');

// ================= State =================
let currentUrl = '';
let currentFileName = '';
let currentKind = 'other';
let galleryKind = '';

// ================= Helper umum =================
// Membuat elemen; teks selalu lewat textContent agar aman dari HTML/XSS (nama file dari server)
function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

function icon(classes) {
    return el('i', classes);
}

function formatBytes(bytes) {
    if (bytes === null || bytes === undefined || Number.isNaN(bytes)) return 'Tidak diketahui';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(2)} KB`;
    if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(2)} MB`;
    return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

function formatDate(iso) {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' });
}

function showMessage(text, type = 'error') {
    messageArea.textContent = '';
    const iconClass = type === 'error' ? 'fa-exclamation-circle'
        : type === 'success' ? 'fa-check-circle' : 'fa-info-circle';
    const box = el('div', `alert alert-${type}`);
    box.append(icon(`fas ${iconClass}`), el('span', null, text));
    messageArea.append(box);

    if (type !== 'error') {
        setTimeout(() => {
            if (messageArea.contains(box)) messageArea.textContent = '';
        }, 5000);
    }
}

function clearMessages() {
    messageArea.textContent = '';
}

// Panggilan ke backend, melempar Error dengan pesan yang bisa ditampilkan
async function apiJson(path, options = {}) {
    let response;
    try {
        response = await fetch(path, options);
    } catch {
        throw new Error('Tidak bisa terhubung ke server. Pastikan server DownloadMaster berjalan.');
    }
    let data = {};
    try { data = await response.json(); } catch { /* respons bukan JSON */ }
    if (!response.ok) throw new Error(data.error || `Permintaan gagal (HTTP ${response.status})`);
    return data;
}

// ================= Bagian 1: Analisis & download link =================
function setAnalyzing(loading) {
    analyzeBtn.disabled = loading;
    analyzeBtn.textContent = '';
    if (loading) {
        analyzeBtn.append(el('div', 'loading-spinner'), ' Menganalisis...');
    } else {
        analyzeBtn.append(icon('fas fa-search'), ' Analisis');
    }
}

function iconForKind(kind) {
    return {
        image: 'fas fa-file-image',
        video: 'fas fa-file-video',
        audio: 'fas fa-file-audio',
        document: 'fas fa-file-pdf',
        archive: 'fas fa-file-archive',
    }[kind] || 'fas fa-file-download';
}

function readableType(contentType, kind) {
    const labels = {
        image: 'Gambar', video: 'Video', audio: 'Audio', document: 'Dokumen',
    };
    return `${labels[kind] || 'File'} (${contentType || 'tipe tidak diketahui'})`;
}

async function analyzeUrl() {
    let url = urlInput.value.trim();

    if (!url) {
        showMessage('❌ Silakan masukkan URL terlebih dahulu!', 'error');
        return;
    }
    if (!/^https?:\/\//i.test(url)) {
        url = 'https://' + url;
        urlInput.value = url;
    }
    try {
        new URL(url);
    } catch {
        showMessage('❌ URL tidak valid! Pastikan formatnya benar (contoh: https://example.com/file.mp4)', 'error');
        return;
    }

    setAnalyzing(true);
    clearMessages();
    previewArea.classList.add('hidden');

    try {
        const info = await apiJson(`/api/info?url=${encodeURIComponent(url)}`);

        currentUrl = info.url;
        currentFileName = info.fileName;
        currentKind = info.kind;

        fileNameEl.textContent = info.fileName.length > 50 ? info.fileName.slice(0, 47) + '...' : info.fileName;
        fileNameEl.title = info.fileName;
        fileSizeEl.textContent = '';
        fileSizeEl.append(icon('fas fa-database'), ` Ukuran: ${formatBytes(info.size)}`);
        fileTypeEl.textContent = '';
        fileTypeEl.append(icon('fas fa-tag'), ` Tipe: ${readableType(info.contentType, info.kind)}`);
        fileTypeIcon.className = iconForKind(info.kind);

        previewArea.classList.remove('hidden');
        showMessage('✅ Link berhasil dianalisis! Klik tombol download untuk mulai mengunduh.', 'success');
    } catch (err) {
        showMessage(`❌ ${err.message}`, 'error');
    } finally {
        setAnalyzing(false);
    }
}

function triggerDownload() {
    if (!currentUrl) {
        showMessage('❌ Tidak ada URL yang siap. Silakan analisis link terlebih dahulu.', 'error');
        return;
    }
    // Browser mengunduh langsung dari endpoint proxy (Content-Disposition: attachment),
    // jadi file besar tidak dimuat ke memori halaman dan tidak ada masalah CORS.
    const link = document.createElement('a');
    link.href = `/api/download?url=${encodeURIComponent(currentUrl)}`;
    document.body.appendChild(link);
    link.click();
    link.remove();

    showMessage(`✅ Unduhan dimulai! Nama file: ${currentFileName}`, 'success');
}

function resetForNewDownload() {
    currentUrl = '';
    currentFileName = '';
    urlInput.value = '';
    previewArea.classList.add('hidden');
    clearMessages();
    urlInput.focus();
}

// ================= Bagian 2: Upload foto & video =================
function isAllowedMedia(file) {
    if (file.type.startsWith('image/') || file.type.startsWith('video/')) return true;
    return /\.(jpe?g|png|gif|webp|heic|heif|mp4|m4v|mov|webm|mkv|avi|mpe?g)$/i.test(file.name);
}

// Upload satu file dengan progres; memakai XHR karena fetch belum punya event progres upload
function uploadFile(file, onProgress) {
    return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', '/api/upload');
        xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
        xhr.setRequestHeader('X-File-Name', encodeURIComponent(file.name));
        xhr.upload.onprogress = (e) => {
            if (e.lengthComputable) onProgress(e.loaded / e.total);
        };
        xhr.onload = () => {
            let data = {};
            try { data = JSON.parse(xhr.responseText); } catch { /* bukan JSON */ }
            if (xhr.status >= 200 && xhr.status < 300) resolve(data);
            else reject(new Error(data.error || `HTTP ${xhr.status}`));
        };
        xhr.onerror = () => reject(new Error('Koneksi terputus saat mengupload.'));
        xhr.onabort = () => reject(new Error('Upload dibatalkan.'));
        xhr.send(file);
    });
}

function createUploadRow(file) {
    const row = el('div', 'upload-row');
    const top = el('div', 'upload-row-top');
    top.append(el('span', 'upload-name', file.name), el('span', 'upload-status', 'Menunggu...'));
    const bar = el('div', 'progress');
    const fill = el('div', 'progress-fill');
    bar.append(fill);
    row.append(top, bar);
    uploadList.append(row);
    return {
        setProgress(ratio) {
            fill.style.width = `${Math.round(ratio * 100)}%`;
            top.lastChild.textContent = `${Math.round(ratio * 100)}%`;
        },
        setStatus(text, state) {
            top.lastChild.textContent = text;
            row.classList.toggle('upload-done', state === 'done');
            row.classList.toggle('upload-error', state === 'error');
        },
    };
}

async function handleFiles(files) {
    const list = Array.from(files);
    if (!list.length) return;

    uploadMessage.textContent = '';
    let ok = 0;
    let failed = 0;

    for (const file of list) {
        if (!isAllowedMedia(file)) {
            const row = createUploadRow(file);
            row.setStatus('Format tidak didukung', 'error');
            failed++;
            continue;
        }
        const row = createUploadRow(file);
        row.setStatus('Mengupload...');
        try {
            await uploadFile(file, row.setProgress);
            row.setProgress(1);
            row.setStatus('Tersimpan ✓', 'done');
            ok++;
        } catch (err) {
            row.setStatus(err.message, 'error');
            failed++;
        }
    }

    const summary = `${ok} file tersimpan${failed ? `, ${failed} gagal` : ''}.`;
    uploadMessage.append(el('div', `alert alert-${failed ? 'warning' : 'success'}`, summary));
    fileInput.value = '';
    if (ok) loadGallery();
}

// ================= Bagian 3: Koleksi tersimpan =================
function buildMediaCard(item) {
    const card = el('div', 'media-card');

    const thumb = el('div', 'media-thumb');
    if (item.kind === 'image') {
        const img = el('img');
        img.loading = 'lazy';
        img.alt = item.name;
        img.src = item.url;
        thumb.append(img);
    } else {
        const video = document.createElement('video');
        video.src = item.url;
        video.preload = 'metadata';
        video.controls = true;
        video.muted = true;
        thumb.append(video);
    }

    const body = el('div', 'media-body');
    const name = el('div', 'media-name', item.name);
    name.title = item.name;
    const meta = el('div', 'media-meta',
        `${item.kind === 'image' ? 'Foto' : 'Video'} · ${formatBytes(item.size)} · ${formatDate(item.uploadedAt)}`);

    const actions = el('div', 'media-actions');

    const dl = el('a', 'btn-sm btn-download-sm');
    dl.href = item.downloadUrl;
    dl.append(icon('fas fa-download'), ' Download');

    const open = el('a', 'btn-sm btn-outline');
    open.href = item.url;
    open.target = '_blank';
    open.rel = 'noopener';
    open.append(icon('fas fa-external-link-alt'), ' Buka');

    const del = el('button', 'btn-sm btn-danger');
    del.type = 'button';
    del.append(icon('fas fa-trash'), ' Hapus');
    del.addEventListener('click', () => deleteItem(item, del));

    actions.append(dl, open, del);
    body.append(name, meta, actions);
    card.append(thumb, body);
    return card;
}

async function loadGallery() {
    const query = galleryKind ? `?kind=${galleryKind}` : '';
    try {
        const data = await apiJson(`/api/files${query}`);
        gallery.textContent = '';
        data.items.forEach((item) => gallery.append(buildMediaCard(item)));
        galleryCount.textContent = `${data.total} file tersimpan`;
        galleryEmpty.classList.toggle('hidden', data.total > 0);
    } catch (err) {
        galleryCount.textContent = '';
        uploadMessage.textContent = '';
        uploadMessage.append(el('div', 'alert alert-error', `❌ Gagal memuat koleksi: ${err.message}`));
    }
}

async function deleteItem(item, button) {
    if (!confirm(`Hapus "${item.name}" dari server?`)) return;
    button.disabled = true;
    try {
        await apiJson(`/api/files/${item.id}`, { method: 'DELETE' });
        loadGallery();
    } catch (err) {
        button.disabled = false;
        alert(`Gagal menghapus: ${err.message}`);
    }
}

// ================= Event listeners =================
analyzeBtn.addEventListener('click', analyzeUrl);
downloadBtn.addEventListener('click', triggerDownload);
newDownloadBtn.addEventListener('click', resetForNewDownload);
urlInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') analyzeUrl();
});

dropzone.addEventListener('click', () => fileInput.click());
dropzone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        fileInput.click();
    }
});
fileInput.addEventListener('change', () => handleFiles(fileInput.files));
['dragenter', 'dragover'].forEach((type) => {
    dropzone.addEventListener(type, (e) => {
        e.preventDefault();
        dropzone.classList.add('dragging');
    });
});
['dragleave', 'drop'].forEach((type) => {
    dropzone.addEventListener(type, (e) => {
        e.preventDefault();
        dropzone.classList.remove('dragging');
    });
});
dropzone.addEventListener('drop', (e) => handleFiles(e.dataTransfer.files));

refreshBtn.addEventListener('click', loadGallery);
tabs.forEach((tab) => {
    tab.addEventListener('click', () => {
        tabs.forEach((t) => t.classList.remove('active'));
        tab.classList.add('active');
        galleryKind = tab.dataset.kind;
        loadGallery();
    });
});

// Awal
urlInput.focus();
loadGallery();
