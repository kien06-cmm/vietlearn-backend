// Lớp lỗi HTTP dùng chung: mang theo mã trạng thái và mã lỗi để route trả về JSON đúng định dạng.

class HttpError extends Error {
    constructor(status, message, code) {
        super(message);
        this.status = status;
        this.code = code || null;
    }
}

module.exports = { HttpError };
