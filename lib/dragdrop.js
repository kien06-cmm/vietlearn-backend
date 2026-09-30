'use strict';

/**
 * lib/dragdrop.js — GĐ3.7B (câu hỏi "Kéo-thả", type: 'drag_drop')
 *
 * Logic THUẦN (không đụng Firestore/I-O) để chấm và dựng dữ liệu "Xem lại"/"File ôn tập" cho câu Kéo-thả.
 * lib/grading.js require() file này và re-export, nên server.js chỉ cần import từ './lib/grading'.
 * Schema (khớp ngan-hang-cau-hoi.js / buildDragDropView() trong grading.js):
 *   dropZones [{id,label}] · dragItems [{id,text}] · correctMap { [zoneId]: itemId }
 * Đáp án học sinh (lam_bai.js): { [zoneId]: itemId }, ô chưa thả thì không có key.
 */

/**
 * (GĐ3.7B) Đọc "khung" câu Kéo-thả từ câu hỏi THẬT (chưa sanitize):
 *   dropZones  : [{ id, label }]        — các ô thả
 *   dragItems  : [{ id, text }]         — mọi thẻ (thẻ đúng + thẻ gây nhiễu)
 *   correctMap : { [zoneId]: itemId }   — ĐÁP ÁN
 * `gradable` = các ô CHẤM ĐƯỢC: có thẻ đúng trong correctMap VÀ thẻ đó còn tồn tại trong dragItems
 * (câu bị sửa hỏng không được làm mẫu số điểm từng phần bị sai). Id luôn được ép về chuỗi để so sánh.
 */
function getDragDropSpec(q) {
    const zones = (Array.isArray(q && q.dropZones) ? q.dropZones : [])
        .filter((z) => z && z.id !== undefined && z.id !== null);
    const items = (Array.isArray(q && q.dragItems) ? q.dragItems : [])
        .filter((it) => it && it.id !== undefined && it.id !== null);
    const map = (q && q.correctMap && typeof q.correctMap === 'object' && !Array.isArray(q.correctMap)) ? q.correctMap : {};

    const zoneIdSet = new Set(zones.map((z) => String(z.id)));
    const itemIdSet = new Set(items.map((it) => String(it.id)));
    const gradable = zones
        .filter((z) => map[z.id] !== undefined && map[z.id] !== null && itemIdSet.has(String(map[z.id])))
        .map((z) => ({ zoneId: String(z.id), itemId: String(map[z.id]) }));

    return { zones, items, gradable, zoneIdSet, itemIdSet };
}

/** (GĐ3.7B) { zones: { [id]: label }, items: { [id]: text } } — ảnh chụp nội dung lúc chấm, lưu vào results.details. */
function buildDragDropTexts(q) {
    const spec = getDragDropSpec(q);
    const zones = {};
    const items = {};
    spec.zones.forEach((z) => { zones[String(z.id)] = typeof z.label === 'string' ? z.label : ''; });
    spec.items.forEach((it) => { items[String(it.id)] = typeof it.text === 'string' ? it.text : ''; });
    return { zones, items };
}

/**
 * (GĐ3.7B) CHẤM ĐIỂM "drag_drop". Học sinh nộp object { [zoneId]: itemId } (lam_bai.js — ô chưa thả
 * thì không có key). Điểm từng phần = số ô đặt ĐÚNG thẻ / tổng số ô chấm được (cùng công thức với
 * Ghép đôi / Sắp xếp). Quy tắc:
 *   - Không gửi gì / rỗng / kiểu lạ            -> skipped:true, studentAnswerNormalized = null.
 *   - Id ô hoặc id thẻ không tồn tại           -> bỏ phần đó (chỉ đến từ việc sửa request), không crash.
 *   - 1 thẻ nằm ở >= 2 ô (client thật không làm được) -> 0 điểm, KHÔNG phải bỏ qua.
 * studentAnswerNormalized chỉ chứa cặp hợp lệ, id ép về chuỗi.
 */
function gradeDragDrop(q, rawStudentAnswer) {
    const spec = getDragDropSpec(q);
    const correctAnswerForDetail = spec.gradable;
    const rawObj = (rawStudentAnswer && typeof rawStudentAnswer === 'object' && !Array.isArray(rawStudentAnswer))
        ? rawStudentAnswer : {};

    if (Object.keys(rawObj).length === 0) {
        return { fraction: 0, studentAnswerNormalized: null, correctAnswerForDetail, skipped: true };
    }

    const cleaned = {};
    const seenItems = new Set();
    let duplicated = false;
    Object.keys(rawObj).forEach((zoneId) => {
        const rawItemId = rawObj[zoneId];
        if (!spec.zoneIdSet.has(zoneId)) return;
        if (typeof rawItemId !== 'string' && typeof rawItemId !== 'number') return;
        const itemId = String(rawItemId);
        if (!spec.itemIdSet.has(itemId)) return;
        if (seenItems.has(itemId)) duplicated = true;
        seenItems.add(itemId);
        cleaned[zoneId] = itemId;
    });

    if (duplicated || spec.gradable.length === 0) {
        return { fraction: 0, studentAnswerNormalized: cleaned, correctAnswerForDetail, skipped: false };
    }

    let correct = 0;
    spec.gradable.forEach((g) => { if (cleaned[g.zoneId] === g.itemId) correct += 1; });

    return {
        fraction: correct / spec.gradable.length,
        studentAnswerNormalized: cleaned,
        correctAnswerForDetail,
        skipped: false
    };
}

/**
 * (GĐ3.7B) Dữ liệu "Xem lại" câu Kéo-thả cho ketqua.js (tách từ route /api/get-result-detail để test được).
 * Nhận câu hỏi THẬT `q` và 1 phần tử `d` của results.details. Nội dung chữ ưu tiên ảnh chụp lúc chấm
 * (d.dragTexts) để giáo viên sửa câu SAU khi học sinh nộp cũng không làm lệch màn Xem lại; thiếu thì dùng q.
 * Trả về { zones: [{ label, correctText, studentText, placed, isCorrect }], distractors: [text] }.
 */
function buildDragDropResultView(q, d) {
    const correctList = (Array.isArray(d && d.correctAnswer) ? d.correctAnswer : [])
        .filter((g) => g && g.zoneId !== undefined && g.zoneId !== null && g.itemId !== undefined && g.itemId !== null);

    const live = buildDragDropTexts(q);
    const snap = (d && d.dragTexts && typeof d.dragTexts === 'object') ? d.dragTexts : {};
    const labelById = { ...live.zones, ...((snap.zones && typeof snap.zones === 'object') ? snap.zones : {}) };
    const textById = { ...live.items, ...((snap.items && typeof snap.items === 'object') ? snap.items : {}) };
    const labelOf = (id) => (typeof labelById[id] === 'string' ? labelById[id] : '');
    const textOf = (id) => (typeof textById[id] === 'string' ? textById[id] : '');

    const studentMap = (d && d.studentAnswer && typeof d.studentAnswer === 'object' && !Array.isArray(d.studentAnswer))
        ? d.studentAnswer : {};

    const zones = correctList.map((g) => {
        const zoneId = String(g.zoneId);
        const correctItemId = String(g.itemId);
        const chosen = studentMap[zoneId];
        const placed = chosen !== undefined && chosen !== null && chosen !== '';
        return {
            label: labelOf(zoneId),
            correctText: textOf(correctItemId),
            studentText: placed ? textOf(String(chosen)) : '',
            placed,
            isCorrect: placed && String(chosen) === correctItemId
        };
    });

    const correctItemIds = new Set(correctList.map((g) => String(g.itemId)));
    const distractors = Object.keys(textById).filter((id) => !correctItemIds.has(id)).map((id) => textById[id]);

    return { zones, distractors };
}

/**
 * (GĐ3.7B) Dữ liệu câu Kéo-thả cho file ôn tập PDF/Word (toReviewQuestionServer): các cặp ô thả -> thẻ đúng theo
 * thứ tự ô, kèm danh sách thẻ gây nhiễu. Chỉ gửi cho học sinh khi checkReviewDownloadAccess() đã cho phép.
 */
function buildDragDropReview(q) {
    const spec = getDragDropSpec(q);
    const texts = buildDragDropTexts(q);
    const correctItemIds = new Set(spec.gradable.map((g) => g.itemId));
    return {
        dragDropPairs: spec.gradable.map((g) => ({ label: texts.zones[g.zoneId] || '', text: texts.items[g.itemId] || '' })),
        dragDropDistractors: spec.items
            .filter((it) => !correctItemIds.has(String(it.id)))
            .map((it) => (typeof it.text === 'string' ? it.text : ''))
    };
}

module.exports = {
    getDragDropSpec,
    buildDragDropTexts,
    gradeDragDrop,
    buildDragDropResultView,
    buildDragDropReview
};
