// Hàm tiện ích đề thi: truy cập bài thi, tải câu hỏi, phiên làm bài, lưu bản nộp cũ, quyền tải file ôn tập, đổi mốc thời gian và làm sạch câu hỏi AI bóc tách.

const EXTRACT_VALID_TYPES = ['multiple_choice', 'essay', 'true_false'];

function sanitizeExtractedQuestions(raw) {
    if (!Array.isArray(raw)) return [];

    return raw.filter((q) => {
        if (!q) return false;
        const questionText = typeof q.question_text === 'string' ? q.question_text
            : (typeof q.question === 'string' ? q.question : '');
        if (questionText.trim() === '') return false;
        if (!EXTRACT_VALID_TYPES.includes(q.type)) return false;

        if (q.type === 'multiple_choice') {
            if (Array.isArray(q.options)) {
                return q.options.length >= 2
                    && q.options.every((o) => typeof o === 'string' && o.trim() !== '');
            }
            return Array.isArray(q.answers)
                && q.answers.length >= 2
                && q.answers.every((a) => a && typeof a.text === 'string' && a.text.trim() !== '');
        }
        return true;
    });
}

function createExamHelpers({ dbAdmin, FieldValue, FieldPath }) {
    async function archivePreviousResultAttempt(resultRef) {
        try {
            const prevSnap = await resultRef.get();
            if (!prevSnap.exists) return;
            const prev = prevSnap.data();
            const prevMs = (prev.submitTime && typeof prev.submitTime.toMillis === 'function')
                ? prev.submitTime.toMillis()
                : Date.now();
            await resultRef.collection('attempts').doc(String(prevMs)).set({
                ...prev,
                archivedAt: FieldValue.serverTimestamp()
            });
        } catch (archiveErr) {
            console.error('Không lưu được bản nộp cũ (không chặn việc nộp bài):', archiveErr.message);
        }
    }

    async function loadExamForStudent(examId, studentId) {
        const examSnap = await dbAdmin.collection('exams').doc(examId).get();
        if (!examSnap.exists) {
            return { ok: false, status: 404, message: 'Không tìm thấy bài kiểm tra.' };
        }
        const examData = examSnap.data();

        if (examData.status !== 'active') {
            return { ok: false, status: 403, message: 'Bài kiểm tra đã đóng hoặc chưa mở, không thể tiếp tục.' };
        }

        if (!examData.class_id) {
            return { ok: true, examData };
        }

        const memberSnap = await dbAdmin
            .collection('class_members')
            .doc(`${studentId}_${examData.class_id}`)
            .get();
        if (!memberSnap.exists || memberSnap.data().status !== 'active') {
            return { ok: false, status: 403, message: 'Bạn không phải thành viên đang hoạt động của lớp học này.' };
        }

        return { ok: true, examData };
    }

    async function loadExamForStudentByRoomCode(roomCode, studentId) {
        const examsSnap = await dbAdmin
            .collection('exams')
            .where('roomCode', '==', roomCode)
            .where('status', '==', 'active')
            .limit(1)
            .get();

        if (examsSnap.empty) {
            return { ok: false, status: 404, message: 'Mã phòng không tồn tại hoặc đã đóng.' };
        }

        const examDoc = examsSnap.docs[0];
        const examData = examDoc.data();

        if (!examData.class_id) {
            return { ok: true, examId: examDoc.id, examData };
        }

        const memberSnap = await dbAdmin
            .collection('class_members')
            .doc(`${studentId}_${examData.class_id}`)
            .get();
        if (!memberSnap.exists || memberSnap.data().status !== 'active') {
            return { ok: false, status: 403, message: 'Bạn không phải thành viên đang hoạt động của lớp học này.' };
        }

        return { ok: true, examId: examDoc.id, examData };
    }

    async function loadClassNameById(classId) {
        if (!classId || typeof classId !== 'string') return null;
        try {
            const classSnap = await dbAdmin.collection('classes').doc(classId).get();
            if (!classSnap.exists) return null;
            const name = classSnap.data().className;
            return (typeof name === 'string' && name.trim()) ? name.trim() : null;
        } catch (classErr) {
            console.error('Không lấy được tên lớp (không chặn việc chấm điểm):', classErr.message);
            return null;
        }
    }

    async function fetchQuestionsByIds(questionIds) {
        const chunks = [];
        for (let i = 0; i < questionIds.length; i += 10) {
            chunks.push(questionIds.slice(i, i + 10));
        }

        const chunkSnaps = await Promise.all(
            chunks.map((chunk) =>
                dbAdmin
                    .collection('questions')
                    .where(FieldPath.documentId(), 'in', chunk)
                    .get()
            )
        );

        const questionMap = {};
        chunkSnaps.forEach((snap) => {
            snap.docs.forEach((d) => {
                questionMap[d.id] = { id: d.id, ...d.data() };
            });
        });

        return questionIds.map((id) => questionMap[id]).filter(Boolean);
    }

    async function getOrStartExamSession(examId, studentId, examData) {
        const sessionRef = dbAdmin.collection('exam_sessions').doc(`${examId}_${studentId}`);
        const sessionSnap = await sessionRef.get();

        if (sessionSnap.exists && typeof sessionSnap.data().startedAtMs === 'number') {
            return sessionSnap.data().startedAtMs;
        }

        const startedAtMs = Date.now();
        await sessionRef.set({
            examId,
            studentId,
            startedAtMs,
            startedAt: FieldValue.serverTimestamp(),
            duration: Number(examData.duration) > 0 ? Number(examData.duration) : 15,
            unlimitedTime: examData.unlimitedTime === true
        }, { merge: true });

        return startedAtMs;
    }

    async function checkReviewDownloadAccess(examId, examData, studentId) {
        if (examData.allowDownloadReview !== true) {
            return { ok: false, status: 403, message: 'Giáo viên không bật tính năng tải file ôn tập cho bài kiểm tra này.' };
        }
        if (examData.showScoreImmediately !== true || examData.showCorrectAnswers !== true) {
            return { ok: false, status: 403, message: 'Giáo viên chưa mở phần xem đáp án cho bài kiểm tra này.' };
        }

        const resultSnap = await dbAdmin.collection('results').doc(`${examId}_${studentId}`).get();
        if (!resultSnap.exists || resultSnap.data().student_id !== studentId) {
            return { ok: false, status: 403, message: 'Bạn cần nộp bài trước khi tải file ôn tập.' };
        }

        const maxAttempts = Number(examData.maxAttempts) > 1 ? Number(examData.maxAttempts) : null;
        if (maxAttempts !== null) {
            const attemptSnap = await dbAdmin.collection('exam_attempts').doc(`${examId}_${studentId}`).get();
            const usedAttempts = attemptSnap.exists ? (Number(attemptSnap.data().count) || 0) : 0;
            if (usedAttempts < maxAttempts) {
                return {
                    ok: false,
                    locked: true,
                    status: 403,
                    message: `Bạn còn ${maxAttempts - usedAttempts} lượt làm bài. File ôn tập sẽ mở sau khi bạn dùng hết số lượt.`
                };
            }
        }

        return { ok: true };
    }

    return {
        archivePreviousResultAttempt,
        loadExamForStudent,
        loadExamForStudentByRoomCode,
        loadClassNameById,
        fetchQuestionsByIds,
        getOrStartExamSession,
        checkReviewDownloadAccess
    };
}

function toMillis(value) {
    if (value === null || value === undefined) return null;
    if (typeof value.toMillis === 'function') return value.toMillis();
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.getTime();
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}

module.exports = { sanitizeExtractedQuestions, toMillis, createExamHelpers };
