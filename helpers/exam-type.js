// Hình thức bài kiểm tra lưu ở exams.type: 'quiz' (trắc nghiệm, mặc định), 'essay' (tự luận cả bài), 'upload' (nộp file cả bài).
// PHẢI khớp normalizeExamType() trong frontend/pages/hocsinh/lam-bai/helpers.js.

function normalizeExamType(raw) {
    const value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
    return (value === 'essay' || value === 'upload') ? value : 'quiz';
}

module.exports = { normalizeExamType };
