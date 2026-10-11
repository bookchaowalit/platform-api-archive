---
title: solo-platform-api — Product Card
doc_id: CARD-solo-platform-api
doc_type: product-card
verdict: archive
version: 0.1
date: 2026-10-11
status: ร่างเพื่อพิจารณา
owner: Product owner (Book Dev)
---

# solo-platform-api — Product Card

## 1. สรุปคุณค่าในหนึ่งประโยค

เก็บโค้ด REST server เดิมของ Solo Empire (auth, rate limit, webhook LINE/Stripe, building blocks เช่น ภาษี/ใบกำกับไทย) ไว้เป็นคลังอ้างอิงให้ยกโมดูลไปใช้ใน cell อื่น

## 2. ปัญหาและผู้ใช้เป้าหมาย

- ปัญหา: `infra/api` และ `infra/dashboard` ถูกปลดระวางเมื่อ 2026-10-11 แต่โมดูลบางตัวอาจต้องใช้ซ้ำ
- ผู้ใช้: เจ้าของ (เป็นคลังอ้างอิง ไม่ใช่ระบบที่ใช้งาน)

## 3. สิ่งที่ทำได้จริงตอนนี้

- ไม่ได้รันเองได้: README ระบุว่าสร้างมาสำหรับ tree `infra/` ของ solo-empire (import `../database`, `../platform/*.yaml`)
- มี `server.ts`, `auth.ts`, `line.ts`, `stripe.ts`, `telemetry.ts` และโฟลเดอร์ `platform/` (identity verify, Thai tax/invoice preview, email, presigned files) กับ `tests/` ที่เป็นสำเนาไว้อ้างอิงเท่านั้น

## 4. หลักฐานสถานะ

| รายการ | ค่า (ตรวจจาก repository) |
|---|---|
| Stack | TypeScript (Node) |
| Commits | 30 (แรก 2026-06-14 → ล่าสุด 2026-10-11) |
| Source | ประมาณ 5,320 บรรทัดใน 21 ไฟล์ (ไม่รวมเทสต์) |
| Tests | 6 ไฟล์ |
| CI | ไม่มี |
| Deploy config | ไม่มี (README ระบุว่า archive และไม่ runnable) |
| Live URL | ไม่มี (ไม่ได้ตรวจ) |
| README | 12 บรรทัด |

## 5. คุณค่าและจุดต่าง

- ค่าหลักคือโมดูลที่ยกไปใช้ต่อได้ (เช่น `platform/thai_tax.ts`) และประวัติ git
- มุมรายได้: ไม่มี

## 6. ช่องว่างสำคัญ

- รันเดี่ยวไม่ได้; `media_router.ts` และ `external_app_registry.ts` ย้ายกลับไปอยู่ solo-empire แล้ว
- ไม่มี CI และ README สั้น

## 7. คำตัดสิน

**`archive`** — README ประกาศเป็น archive และงานจริงย้ายไป cell API กับ `solo-web` แล้ว จะเปลี่ยนถ้ามีโมดูลที่ต้องกลับมาใช้ซ้ำเป็นประจำ (ควรยกไปเป็น library แยก)

## 8. ขั้นต่อไป

1. ขออนุมัติเจ้าของเพื่อ archive repo บน GitHub
2. ก่อน archive ให้ยกโมดูลที่ยังต้องใช้ (เช่น `platform/thai_tax.ts`) ไปไว้ใน cell ที่เป็นเจ้าของ

## การอนุมัติ

| บทบาท | สถานะ | วันที่ | ลงนาม |
|---|---|---|---|
| Product owner (Book Dev) | รอพิจารณา | — | ________ |

## แหล่งข้อมูล

- `README.md`
- โครงไฟล์ระดับบนของ repo (`server.ts`, `platform/`, `tests/`)
