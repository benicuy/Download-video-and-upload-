// DOM Elements
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

// State
let currentUrl = '';
let currentFileName = '';
let currentFileType = '';

// Helper: Show message
function showMessage(message, type = 'error') {
    messageArea.innerHTML = `
        <div class="alert alert-${type}">
            <i class="fas ${type === 'error' ? 'fa-exclamation-circle' : type === 'success' ? 'fa-check-circle' : 'fa-info-circle'}"></i>
            <span>${message}</span>
        </div>
    `;
    
    // Auto hide after 5 seconds for success/info
    if (type !== 'error') {
        setTimeout(() => {
            if (messageArea.innerHTML.includes(message)) {
                messageArea.innerHTML = '';
            }
        }, 5000);
    }
}

// Helper: Clear messages
function clearMessages() {
    messageArea.innerHTML = '';
}

// Helper: Get file extension from URL
function getFileExtension(url) {
    try {
        // Remove query parameters and hash
        const cleanUrl = url.split('?')[0].split('#')[0];
        const filename = cleanUrl.split('/').pop();
        const extension = filename.includes('.') ? filename.split('.').pop().toLowerCase() : '';
        return { extension, filename };
    } catch (e) {
        return { extension: '', filename: 'file' };
    }
}

// Helper: Get icon class based on extension
function getIconForExtension(extension) {
    const videoExts = ['mp4', 'mkv', 'avi', 'mov', 'wmv', 'flv', 'webm', 'm4v', 'mpg', 'mpeg'];
    const audioExts = ['mp3', 'wav', 'ogg', 'flac', 'aac', 'm4a'];
    const imageExts = ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'svg', 'ico'];
    const pdfExts = ['pdf'];
    const archiveExts = ['zip', 'rar', '7z', 'tar', 'gz', 'bz2'];
    const docExts = ['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'csv'];
    
    if (videoExts.includes(extension)) return 'fas fa-file-video';
    if (audioExts.includes(extension)) return 'fas fa-file-audio';
    if (imageExts.includes(extension)) return 'fas fa-file-image';
    if (pdfExts.includes(extension)) return 'fas fa-file-pdf';
    if (archiveExts.includes(extension)) return 'fas fa-file-archive';
    if (docExts.includes(extension)) return 'fas fa-file-alt';
    return 'fas fa-file-download';
}

// Helper: Get readable file type
function getReadableType(extension) {
    const types = {
        'mp4': 'Video MP4', 'mkv': 'Video Matroska', 'avi': 'Video AVI', 'mov': 'Video QuickTime',
        'mp3': 'Audio MP3', 'wav': 'Audio WAV', 'jpg': 'Gambar JPEG', 'jpeg': 'Gambar JPEG',
        'png': 'Gambar PNG', 'pdf': 'Dokumen PDF', 'zip': 'Arsip ZIP', 'rar': 'Arsip RAR',
        'txt': 'Dokumen Teks', 'json': 'Data JSON', 'xml': 'Data XML'
    };
    return types[extension] || (extension ? `File .${extension.toUpperCase()}` : 'Unknown');
}

// Helper: Get file size from headers (HEAD request)
async function fetchFileMetadata(url) {
    try {
        // Use fetch with HEAD method to get metadata without downloading full file
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 8000);
        
        const response = await fetch(url, {
            method: 'HEAD',
            mode: 'cors',
            signal: controller.signal
        });
        
        clearTimeout(timeoutId);
        
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }
        
        // Get file size from headers
        const contentLength = response.headers.get('content-length');
        const contentType = response.headers.get('content-type');
        
        let sizeText = 'Tidak diketahui';
        if (contentLength) {
            const bytes = parseInt(contentLength);
            if (bytes < 1024) sizeText = `${bytes} B`;
            else if (bytes < 1024 * 1024) sizeText = `${(bytes / 1024).toFixed(2)} KB`;
            else if (bytes < 1024 * 1024 * 1024) sizeText = `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
            else sizeText = `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
        }
        
        return {
            size: sizeText,
            contentType: contentType || 'application/octet-stream',
            success: true
        };
    } catch (error) {
        console.warn('Could not fetch metadata:', error);
        return {
            size: 'Tidak diketahui',
            contentType: 'application/octet-stream',
            success: false
        };
    }
}

// Main function: Analyze URL
async function analyzeUrl() {
    let url = urlInput.value.trim();
    
    if (!url) {
        showMessage('❌ Silakan masukkan URL terlebih dahulu!', 'error');
        return;
    }
    
    // Add http:// if no protocol
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
        url = 'https://' + url;
        urlInput.value = url;
    }
    
    // Validate URL format
    try {
        new URL(url);
    } catch (e) {
        showMessage('❌ URL tidak valid! Pastikan formatnya benar (contoh: https://example.com/file.mp4)', 'error');
        return;
    }
    
    // Show loading state
    analyzeBtn.disabled = true;
    analyzeBtn.innerHTML = '<div class="loading-spinner"></div> Menganalisis...';
    clearMessages();
    previewArea.classList.add('hidden');
    
    // Extract file info from URL
    const { extension, filename } = getFileExtension(url);
    
    if (!extension) {
        analyzeBtn.disabled = false;
        analyzeBtn.innerHTML = '<i class="fas fa-search"></i> Analisis';
        showMessage('⚠️ URL tidak memiliki ekstensi file yang jelas. Namun Anda tetap bisa mencoba mendownloadnya.', 'warning');
        // Continue anyway
    }
    
    // Try to fetch metadata for size info
    const metadata = await fetchFileMetadata(url);
    
    currentUrl = url;
    currentFileName = filename || 'downloaded_file';
    currentFileType = extension || 'file';
    
    // Update preview UI
    fileNameEl.textContent = currentFileName.length > 50 ? currentFileName.substring(0, 47) + '...' : currentFileName;
    fileSizeEl.innerHTML = `<i class="fas fa-database"></i> Ukuran: ${metadata.size}`;
    fileTypeEl.innerHTML = `<i class="fas fa-tag"></i> Tipe: ${getReadableType(extension)}`;
    
    const iconClass = getIconForExtension(extension);
    fileTypeIcon.className = iconClass;
    
    // Show preview
    previewArea.classList.remove('hidden');
    
    // Show success message
    showMessage('✅ Link berhasil dianalisis! Klik tombol download untuk mulai mengunduh.', 'success');
    
    analyzeBtn.disabled = false;
    analyzeBtn.innerHTML = '<i class="fas fa-search"></i> Analisis';
}

// Function: Trigger download
async function triggerDownload() {
    if (!currentUrl) {
        showMessage('❌ Tidak ada URL yang siap. Silakan analisis link terlebih dahulu.', 'error');
        return;
    }
    
    // Disable download button during process
    downloadBtn.disabled = true;
    const originalBtnText = downloadBtn.innerHTML;
    downloadBtn.innerHTML = '<div class="loading-spinner"></div> Memulai unduhan...';
    
    try {
        // Method 1: Use anchor tag with download attribute (works for same-origin or blob)
        // But for cross-origin, we use fetch + blob to force download
        
        // Try to fetch the file as blob
        showMessage('⏳ Mengambil data file, mohon tunggu...', 'info');
        
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 30000); // 30 second timeout
        
        const response = await fetch(currentUrl, {
            mode: 'cors',
            signal: controller.signal
        });
        
        clearTimeout(timeoutId);
        
        if (!response.ok) {
            throw new Error(`Gagal mengambil file: HTTP ${response.status}`);
        }
        
        const blob = await response.blob();
        
        // Create download link
        const blobUrl = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = blobUrl;
        
        // Determine filename
        let finalFileName = currentFileName;
        if (!finalFileName || finalFileName === 'downloaded_file') {
            const contentDisposition = response.headers.get('content-disposition');
            if (contentDisposition && contentDisposition.includes('filename=')) {
                const match = contentDisposition.match(/filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/);
                if (match && match[1]) {
                    finalFileName = match[1].replace(/['"]/g, '');
                }
            } else {
                // Extract from URL
                const urlParts = currentUrl.split('/');
                let lastPart = urlParts.pop() || 'download';
                lastPart = lastPart.split('?')[0];
                if (lastPart.includes('.')) {
                    finalFileName = lastPart;
                } else {
                    // Add extension based on content type
                    const ext = getExtensionFromMime(blob.type);
                    finalFileName = `download${ext ? '.' + ext : '.file'}`;
                }
            }
        }
        
        link.download = finalFileName;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        
        // Clean up blob URL
        setTimeout(() => URL.revokeObjectURL(blobUrl), 100);
        
        showMessage(`✅ Unduhan dimulai! Nama file: ${finalFileName} (${(blob.size / 1024 / 1024).toFixed(2)} MB jika tersedia)`, 'success');
        
    } catch (error) {
        console.error('Download error:', error);
        
        // Fallback: Try direct navigation (opens in new tab or triggers download)
        if (error.name === 'AbortError') {
            showMessage('⏰ Waktu habis! Server terlalu lama merespons. Coba lagi nanti.', 'error');
        } else if (error.message.includes('Failed to fetch') || error.message.includes('CORS')) {
            showMessage('⚠️ Gagal mengambil file karena kebijakan CORS. Mencoba metode alternatif...', 'warning');
            
            // Fallback method: Open in new tab/window (may download or display)
            const win = window.open(currentUrl, '_blank');
            if (win) {
                showMessage('🔗 Link dibuka di tab baru. Jika tidak otomatis terunduh, klik kanan dan pilih "Save link as..."', 'info');
            } else {
                showMessage('❌ Popup diblokir! Izinkan popup untuk metode alternatif, atau salin link dan buka manual.', 'error');
            }
        } else {
            showMessage(`❌ Gagal mengunduh: ${error.message}. Pastikan link valid dan dapat diakses.`, 'error');
        }
    } finally {
        downloadBtn.disabled = false;
        downloadBtn.innerHTML = originalBtnText;
    }
}

// Helper: Get extension from MIME type
function getExtensionFromMime(mimeType) {
    const mimeMap = {
        'video/mp4': 'mp4', 'video/x-matroska': 'mkv', 'video/quicktime': 'mov',
        'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'image/jpeg': 'jpg',
        'image/png': 'png', 'application/pdf': 'pdf', 'application/zip': 'zip',
        'text/plain': 'txt', 'application/json': 'json'
    };
    return mimeMap[mimeType] || '';
}

// Reset for new download
function resetForNewDownload() {
    currentUrl = '';
    currentFileName = '';
    currentFileType = '';
    urlInput.value = '';
    previewArea.classList.add('hidden');
    clearMessages();
    urlInput.focus();
}

// Event Listeners
analyzeBtn.addEventListener('click', analyzeUrl);
downloadBtn.addEventListener('click', triggerDownload);
newDownloadBtn.addEventListener('click', resetForNewDownload);

// Enter key support
urlInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
        analyzeUrl();
    }
});

// Initial placeholder focus
urlInput.focus();
