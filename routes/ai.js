// Router AI: bóc tách câu hỏi từ file PDF và biên dịch công thức Toán sang LaTeX bằng Gemini.

const express = require('express');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { sanitizeExtractedQuestions } = require('../helpers/exam-helpers');

const EXTRACT_SYSTEM_PROMPT = `Bạn LÀ công cụ trích xuất dữ liệu, KHÔNG phải người soạn đề.
Nhiệm vụ: CHỈ ĐƯỢC trích xuất những câu hỏi CÓ SẴN trong tài liệu được cung cấp.

QUY TẮC BẮT BUỘC:
1. TUYỆT ĐỐI KHÔNG tự sáng tác, suy luận hay thêm bớt câu hỏi, đáp án hoặc lời giải. Không viết thêm câu hỏi cho "đủ số lượng", không dùng kiến thức bên ngoài tài liệu.
2. Nếu tài liệu không chứa câu hỏi nào (trắc nghiệm, đúng/sai hoặc tự luận), trả về mảng rỗng [].
3. Giữ nguyên văn câu hỏi và từng đáp án như trong tài liệu. Không diễn đạt lại, không sửa số liệu.
4. Đáp án đúng (correct_option): CHỈ điền số khi tài liệu CHỈ RÕ đáp án đúng (đáp án cuối bài, in đậm, gạch chân, dấu đánh dấu) — là CHỈ MỤC 0-based của đáp án đó trong mảng "options". Nếu tài liệu không chỉ rõ, đặt "correct_option": null. TUYỆT ĐỐI KHÔNG tự giải bài để chọn đáp án đúng.
5. "explanation": chỉ lấy lời giải CÓ SẴN trong tài liệu; không có thì để chuỗi rỗng "".
6. "subject" và "grade": chỉ điền khi tài liệu ghi rõ; không có thì để chuỗi rỗng "". "difficulty": nếu tài liệu không ghi thì dùng "medium".
7. Công thức toán giữ ở dạng LaTeX: dùng \\( ... \\) cho công thức trong dòng và $$ ... $$ cho công thức riêng dòng.

Trả về MỘT MẢNG JSON duy nhất theo ĐÚNG định dạng chuẩn sau (KHÔNG dùng tên field nào khác):
[
  {
    "question_text": "Nội dung câu hỏi",
    "type": "multiple_choice" | "essay" | "true_false",
    "subject": "Tên môn học (chuỗi rỗng nếu tài liệu không ghi)",
    "grade": "Khối lớp (chuỗi rỗng nếu tài liệu không ghi)",
    "difficulty": "easy" | "medium" | "hard",
    "score": 1,
    "options": ["Đáp án A", "Đáp án B"] (Dùng cho trắc nghiệm/đúng-sai; mảng chuỗi thuần, KHÔNG bọc {text, correct}),
    "correct_option": 0 (chỉ mục 0-based trong "options" — null nếu tài liệu không chỉ rõ; luôn null với type=essay),
    "image_url": "",
    "essayAnswer": "Đáp án tự luận mẫu CÓ SẴN trong tài liệu (nếu có)" (Dùng cho tự luận),
    "explanation": "Lời giải có sẵn trong tài liệu (chuỗi rỗng nếu không có)"
  }
]
CHỈ TRẢ VỀ CHUỖI JSON, KHÔNG BỌC TRONG MARKDOWN VÀ KHÔNG THÊM VĂN BẢN NÀO NGOÀI MẢNG JSON.`;

function createAiRouter({ requireTeacherRole }) {
    const router = express.Router();

    router.post('/extract-questions', requireTeacherRole, async (req, res) => {
        try {
            const { source, mimeType, fileBase64 } = req.body;
            console.log("Đã nhận yêu cầu xử lý từ frontend:", source);

            const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
            const model = genAI.getGenerativeModel({
                model: "gemini-3.5-flash-lite",
                systemInstruction: EXTRACT_SYSTEM_PROMPT,
                generationConfig: { temperature: 0, responseMimeType: 'application/json' }
            });

            let requestContent;

            if (source === 'file' && fileBase64) {
                requestContent = [
                    "Trích xuất các câu hỏi CÓ SẴN trong tài liệu đính kèm. Nếu không có câu hỏi nào, trả về [].",
                    {
                        inlineData: {
                            data: fileBase64,
                            mimeType: mimeType || "application/pdf"
                        }
                    }
                ];
            } else {
                return res.status(400).json({ message: "Thiếu file PDF để xử lý. Hệ thống chỉ hỗ trợ file PDF, không còn hỗ trợ Google Forms." });
            }

            const result = await model.generateContent(requestContent);
            const text = result.response.text().replace(/```(?:json)?/gi, '').replace(/```/g, '').trim();

            let parsed;
            try {
                parsed = JSON.parse(text);
            } catch (parseError) {
                console.error("AI trả về JSON không hợp lệ:", text.slice(0, 300));
                return res.status(422).json({ message: "AI trả về dữ liệu không hợp lệ. Vui lòng thử lại." });
            }

            const rawList = Array.isArray(parsed) ? parsed : parsed && parsed.questions;

            res.json({ questions: sanitizeExtractedQuestions(rawList) });

        } catch (error) {
            console.error("Lỗi bóc tách tài liệu:", error);
            res.status(500).json({ message: "Lỗi server khi bóc tách tài liệu." });
        }
    });

    router.post('/compile-math', requireTeacherRole, async (req, res) => {
        try {
            const { input } = req.body;
            const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
            const model = genAI.getGenerativeModel({
                model: "gemini-3.5-flash-lite",
                systemInstruction: "Bạn là bộ chuyển đổi công thức Toán học sang mã LaTeX. CHỈ TRẢ VỀ JSON THUẦN TÚY với cấu trúc: {\"ok\": true, \"type\": \"math\"|\"chemistry\", \"latex\": \"mã_latex\"}. KHÔNG bọc trong markdown hay ký hiệu $ hay $$. TUYỆT ĐỐI không chào hỏi hay giải thích."
            });
            const result = await model.generateContent(input);
            let text = result.response.text().replace(/```(?:json)?/gi, '').replace(/```/g, '').trim();
            res.json(JSON.parse(text));
        } catch (error) {
            console.error("Lỗi biên dịch Toán:", error);
            res.status(500).json({ ok: false, error: "Lỗi server khi biên dịch toán." });
        }
    });

    return router;
}

module.exports = { createAiRouter };
