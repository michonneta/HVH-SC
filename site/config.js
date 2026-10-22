// Cấu hình quy tắc nghiệp vụ. Sửa file này để đổi ngưỡng/quy tắc mà không cần sửa code.
// Mỗi quy tắc ghi rõ trạng thái: CHỐT = đã thống nhất với nghiệp vụ, ĐỀ XUẤT = mặc định chờ xác nhận.

export const CONFIG = {
  // CHỐT – nhóm lý do theo note_type của Pancake; -1/-2 là dòng bổ sung của bảng FactInventory
  reasonGroups: {
    5: 'NCC', 15: 'NCC',
    2: 'Kiểm kê',
    6: 'Bán hàng', 7: 'Bán hàng', 10: 'Bán hàng', 11: 'Bán hàng', 18: 'Bán hàng', 31: 'Bán hàng',
    19: 'Chuyển kho', 20: 'Chuyển kho', 22: 'Chuyển kho', 23: 'Chuyển kho',
    1: 'Khác', 14: 'Khác', 16: 'Khác', 25: 'Khác', 26: 'Khác', 27: 'Khác', 28: 'Khác',
    [-1]: 'Tồn đầu dữ liệu',
    [-2]: 'Chênh lệch hệ thống',
  },
  unknownReason: 'Chưa phân loại',
  reasonOrder: ['NCC', 'Bán hàng', 'Kiểm kê', 'Chuyển kho', 'Khác', 'Tồn đầu dữ liệu', 'Chênh lệch hệ thống', 'Chưa phân loại'],

  // ĐỀ XUẤT – bán thuần = xuất − nhập của nhóm "Bán hàng" (gồm hủy/trả đơn)
  salesReason: 'Bán hàng',

  // ĐỀ XUẤT – SKU không tính vào báo cáo (hàng tặng / vật phẩm; chờ nghiệp vụ xác nhận)
  excludedSkus: [
    { country: 'TH', sku: 'KDH' },
    { country: 'ID', sku: 'MASK 24K' },
  ],

  // CHỐT – ngưỡng trạng thái tồn (DOH theo số lượng = tồn / ADS)
  adsDays: 30,
  lowDoh: 15,      // DOH < 15 ngày: Sắp hết
  highDoh: 60,     // DOH > 60 ngày: Dư thừa
  // ĐỀ XUẤT – thứ tự ưu tiên khi nhiều trạng thái cùng đúng
  statusOrder: ['Âm (pre-order)', 'Hết hàng', 'Không luân chuyển', 'Sắp hết', 'Bình thường', 'Dư thừa'],

  // CHỐT – nhóm tốc độ bán theo đóng góp sản lượng lũy kế (Pareto)
  // ĐỀ XUẤT – xếp hạng trong từng thị trường; SKU vắt qua ranh giới thuộc nhóm trên
  paretoA: 0.80,
  paretoB: 0.95,
  speedOrder: ['Bán chạy', 'Bán ổn định', 'Bán chậm', 'Không bán được'],

  // ĐỀ XUẤT – mẫu số tỷ lệ hết hàng: SKU còn tồn hoặc có biến động trong N ngày gần nhất
  activeDays: 90,

  pageSize: 25,
};
