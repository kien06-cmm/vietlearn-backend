// Router chấm bài: giáo viên nhập điểm, lời phê hoặc miễn thi cho bài làm, kiểm tra bằng transaction để tránh ghi đè bài nộp lại.

const express = require('express');
const { HttpError } = require('../helpers/http-error');
const { toMillis } = require('../helpers/exam-helpers');
const { getBearerToken } = require('../middleware/auth');

const GRADE_FEEDBACK_MAX_CHARS = 2000;
const GRADE_DEFAULT_MAX_SCORE = 10;

function createGradeResultHandler({ authAdmin, dbAdmin, FieldValue }) {
    return async function gradeResultHandler(req, res) {
        try {
            const idToken = getBearerToken(req);
            if (!idToken) throw new HttpError(401, 'Thiếu thông tin đăng nhập.', 'unauthenticated');

            let uid;
            try {
                uid = (await authAdmin.verifyIdToken(idToken)).uid;
            } catch (err) {
                console.error('Token không hợp lệ hoặc đã hết hạn:', err.message);
                throw new HttpError(401, 'Phiên đăng nhập không hợp lệ hoặc đã hết hạn.', 'unauthenticated');
            }

            const body = req.body || {};
            const resultId = typeof body.result_id === 'string' ? body.result_id.trim() : '';
            if (!resultId || resultId.includes('/')) {
                throw new HttpError(400, 'Thiếu hoặc sai result_id.', 'invalid-argument');
            }

            if (body.isExcused !== undefined && typeof body.isExcused !== 'boolean') {
                throw new HttpError(400, 'isExcused phải là true hoặc false.', 'invalid-argument');
            }
            const isExcused = body.isExcused === true;

            let feedback = '';
            if (body.teacherFeedback !== undefined && body.teacherFeedback !== null) {
                if (typeof body.teacherFeedback !== 'string') {
                    throw new HttpError(400, 'Lời phê phải là chuỗi ký tự.', 'invalid-argument');
                }
                feedback = body.teacherFeedback.trim();
                if (feedback.length > GRADE_FEEDBACK_MAX_CHARS) {
                    throw new HttpError(400, `Lời phê tối đa ${GRADE_FEEDBACK_MAX_CHARS} ký tự.`, 'invalid-argument');
                }
            }

            const expectedSubmitTimeMs = (typeof body.expectedSubmitTimeMs === 'number'
                && Number.isFinite(body.expectedSubmitTimeMs)) ? body.expectedSubmitTimeMs : null;

            let score = null;
            if (!isExcused) {
                if (typeof body.score !== 'number' || !Number.isFinite(body.score) || body.score < 0) {
                    throw new HttpError(400, 'Điểm số phải là một số không âm.', 'invalid-argument');
                }
                score = Math.round(body.score * 100) / 100;
            }

            const ref = dbAdmin.collection('results').doc(resultId);

            const saved = await dbAdmin.runTransaction(async (tx) => {
                const snap = await tx.get(ref);
                if (!snap.exists) {
                    throw new HttpError(404, 'Không tìm thấy bài làm (có thể đã bị xóa).', 'not-found');
                }
                const data = snap.data();

                if (data.teacher_id !== uid) {
                    throw new HttpError(403, 'Bạn không có quyền chấm bài làm này.', 'permission-denied');
                }

                const currentSubmitMs = toMillis(data.submitTime);
                if (expectedSubmitTimeMs !== null && currentSubmitMs !== null
                    && Math.abs(Math.floor(currentSubmitMs) - Math.floor(expectedSubmitTimeMs)) > 1) {
                    throw new HttpError(
                        409,
                        'Học sinh vừa nộp lại bài. Bài làm đã được cập nhật, vui lòng chấm lại.',
                        'submission-changed'
                    );
                }

                const update = {
                    teacherFeedback: feedback,
                    gradingStatus: 'graded',
                    gradedAt: FieldValue.serverTimestamp(),
                    gradedBy: uid
                };

                if (isExcused) {
                    update.status = 'excused';
                    update.excused = true;
                    update.score = null;
                } else {
                    const maxScore = Number(data.maxScore) > 0 ? Number(data.maxScore) : GRADE_DEFAULT_MAX_SCORE;
                    if (score > maxScore) {
                        throw new HttpError(400, `Điểm không được lớn hơn ${maxScore}.`, 'invalid-argument');
                    }
                    update.status = 'submitted';
                    update.excused = false;
                    update.score = score;
                }

                tx.update(ref, update);
                return { status: update.status, excused: update.excused, score: update.score };
            });

            return res.json({ ok: true, ...saved });
        } catch (err) {
            if (err instanceof HttpError) {
                return res.status(err.status).json({ ok: false, message: err.message, code: err.code });
            }
            console.error('[/api/grade-result] Lỗi không mong đợi:', err);
            return res.status(500).json({ ok: false, message: 'Lỗi máy chủ khi lưu điểm. Vui lòng thử lại.', code: 'internal' });
        }
    };
}

function createGradingRouter({ authAdmin, dbAdmin, FieldValue }) {
    const router = express.Router();

    router.post('/grade-result', createGradeResultHandler({ authAdmin, dbAdmin, FieldValue }));

    return router;
}

module.exports = { createGradingRouter };
