นี่คือการเรียบเรียงแผนงานทั้งหมดให้อยู่ในรูปแบบ **Product Requirements Document (PRD)** เพื่อใช้เป็นคัมภีร์หลักในการพัฒนาโปรเจกต์นี้ครับ โดยจะจัดลำดับความสำคัญ (Prioritization) ว่าควรทำสิ่งไหนก่อนหลัง เพื่อให้สามารถทดสอบระบบได้เร็วที่สุดในแต่ละเฟส

---

# 📄 Product Requirements Document (PRD)

**Project Name:** cmux-Native AI Orchestrator Harness
**Document Status:** Approved for Development
**Target Stack:** TypeScript, Bun, Ollama (gemma4:12b), cmux, Vanilla Web Tech

## 1. Product Overview (ภาพรวมของระบบ)

ระบบ AI Agent Harness ระดับ Orchestrator ที่ทำงานแบบ Local-first ออกแบบมาเพื่อรันบนสภาพแวดล้อมของ `cmux` โดยเฉพาะ มีหน้าที่เป็น "ผู้บัญชาการ" (Brain) โดยใช้โมเดลขนาดเล็ก (เช่น Gemma) ในการรับคำสั่งจากผู้ใช้ วางแผนงาน และสั่งการ Agent CLI ตัวอื่นๆ (เช่น Claude Code, Codex, Cursor) ให้ทำงานแทน พร้อมระบบแสดงผลชิ้นงาน (Artifacts) บน In-app Browser ที่มีหน้าตาคล้าย VSCode

## 2. Core Objectives (เป้าหมายหลัก)

1. **Local Control:** ทำงานได้อย่างรวดเร็วและปลอดภัยผ่าน Local LLM
2. **Rich Artifacts Display:** สลัดข้อจำกัดของ Terminal เดิมๆ โดยแสดงผล File Explorer, Code และ UI Preview ผ่าน Web View (Port 62120) แบบ Real-time
3. **Infinite Workflow:** รองรับการทำงานยาวนาน 20+ ขั้นตอน โดยไม่ติดข้อจำกัด Context Limit หรือ Quota ของโมเดลใดโมเดลหนึ่ง ผ่านระบบ Context Compaction และ Cascade Fallback

## 3. System Architecture (สถาปัตยกรรมระบบ)

- **Core Runtime:** Bun (ใช้ประมวลผล I/O, รันสคริปต์ และทำหน้าที่เป็น Web Server)
- **Orchestrator LLM:** Ollama + `gemma4:12b` (ทำหน้าที่รับคำสั่ง, สรุปบริบท, และออกคำสั่งต่อ)
- **Inter-process Communication:** `cmux CLI` / PTY (สำหรับแยก Pane และป้อนคำสั่งให้ CLI อื่นๆ)
- **Web View (Artifacts):** พอร์ต `62120` รันด้วย Vanilla CSS + HTML (ใช้ SSE/WebSocket คุยกับ Bun)
- **Agent Chain (Fallback):** Claude Code -> Codex -> Antigravity -> Cursor

---

## 4. Development Plan & Milestones (ลำดับการพัฒนา)

การพัฒนาจะแบ่งเป็นเฟส โดยเริ่มจากการสร้างแกนหลัก (Core) ให้สื่อสารกันได้ ก่อนจะขยายไปสู่ระบบสลับตัว Agent ที่ซับซ้อนขึ้น

### Phase 1: Core Foundation & Web View (สัปดาห์ที่ 1)

**เป้าหมาย:** ระบบต้องสามารถรับส่งข้อมูลระหว่าง Terminal และหน้าเว็บได้

- **1.1 Project Initialization:** ตั้งค่าโปรเจกต์ TypeScript + Bun
- **1.2 Local Server Setup:** สร้าง HTTP Server ด้วย `Bun.serve` รันบนพอร์ต 62120
- **1.3 Web UI Skeleton:** สร้างหน้า `index.html` ด้วย Vanilla CSS แบ่ง Layout เป็น 2 ส่วน
- _Top:_ แสดง Log สรุปสถานะ (Text)
- _Bottom:_ แบ่งเป็น 2 คอลัมน์ (ซ้าย: File Explorer, ขวา: Preview Pane)

- **1.4 Real-time Communication:** พัฒนาระบบ WebSockets หรือ SSE ให้ Bun สามารถยิงข้อมูลไปอัปเดตหน้าเว็บได้ทันทีที่ฝั่ง CLI มีความเคลื่อนไหว

### Phase 2: LLM Orchestrator & TUI (สัปดาห์ที่ 2)

**เป้าหมาย:** เชื่อมต่อสมอง Gemma และทำให้พูดคุยรับคำสั่งบน Terminal ได้

- **2.1 LLM Connector:** เขียนฟังก์ชันต่อ API กับ Local Ollama (`gemma4:12b`)
- **2.2 TUI Implementation:** สร้าง Interactive Prompt บน Terminal ให้ผู้ใช้พิมพ์คำสั่ง
- **2.3 System Prompting:** ออกแบบ Prompt ให้ Gemma เข้าใจบทบาท "ผู้จัดการ" เพื่อแยกแยะว่าคำสั่งไหนต้องตอบกลับเอง และคำสั่งไหนต้องสร้างแผนงาน (Task Plan) ส่งไปที่ Web Log
- **2.4 cmux Automation:** เขียนสคริปต์ให้ Bun สั่ง `cmux` เปิด In-app Browser ทันทีที่รันโปรแกรม

### Phase 3: File System Watcher & VSCode-like UI (สัปดาห์ที่ 3)

**เป้าหมาย:** หน้าเว็บต้องสะท้อนโค้ดที่ถูกสร้างขึ้นในเครื่องได้แบบ Real-time

- **3.1 Project File Watcher:** ใช้ `fs.watch` เฝ้าดูโฟลเดอร์โปรเจกต์เป้าหมาย (เช่น โฟลเดอร์ที่รัน Next.js)
- **3.2 File Tree Generator:** แปลงโครงสร้างโฟลเดอร์ในดิสก์เป็น JSON และส่งไปวาดเป็น File Explorer ที่หน้า Web View ด้านซ้าย
- **3.3 Artifact Previewer:** นำ Library ขนาดเล็ก (เช่น Prism.js หรือ marked.js) มาติดในหน้าเว็บด้านขวา เพื่อให้เมื่อคลิกไฟล์ที่ Explorer แล้ว โค้ดหรือ Markdown จะแสดงผลพร้อม Highlight สีทันที

### Phase 4: Agent Controller & PTY Injector (สัปดาห์ที่ 4)

**เป้าหมาย:** สั่งงาน External CLI (เช่น Claude Code) จากภายในโปรแกรม

- **4.1 Task Parser:** ให้ Gemma แปลงคำสั่งผู้ใช้เป็นคำสั่งพร้อมรัน (เช่น `claude --task "make landing page..."`)
- **4.2 cmux Pane Manager:** สั่ง `cmux split-pane` เพื่อเปิด Terminal ด้านล่างซ้าย
- **4.3 PTY / Spawner:** ใช้ `Bun.spawn` หรือ PTY Library ในการรัน `claude` ลงใน Pane ใหม่ พร้อมป้อนคำสั่งให้เริ่มเขียนโค้ด

### Phase 5: Cascade Fallback & Handover System (สัปดาห์ที่ 5)

**เป้าหมาย:** จัดการเมื่อ Agent ตัวแรกพังหรือโควตาหมด ให้สลับตัวทำงานอัตโนมัติ

- **5.1 Stream Scanner:** เขียน Regex ตรวจจับ Output จาก Pane ของ Agent ปัจจุบัน หากเจอคำว่า `Limit`, `Quota`, `Error` ให้สั่ง Force Stop (Kill Process) ทันที
- **5.2 Agent Chain Router:** สร้าง Logic สลับคิวไปยัง Agent ตัวถัดไป (เช่น หมดจาก Claude ให้เรียกรัน `codex` แทน)
- **5.3 Handover Prompt Engine:** ดึงสถานะปัจจุบัน (ไฟล์ล่าสุดจาก File Watcher และแผนงานที่เหลือ) มาเจนเนอเรตคำสั่งใหม่ (Handover Prompt) เพื่อบรีฟงานให้ Agent ตัวถัดไปทำงานต่อจากจุดที่ค้างไว้ได้เนียนที่สุด

### Phase 6: Infinite Context Compaction (สัปดาห์ที่ 6)

**เป้าหมาย:** ทำให้ Harness (Gemma) ทำงานแบบลืมเหนื่อย

- **6.1 Token Counter:** สร้างตัวนับ Context ของ Gemma เมื่อคุยไปเรื่อยๆ จนใกล้ถึงขีดจำกัด
- **6.2 Auto-Summarization:** เมื่อใกล้ลิมิต ให้ดึงประวัติแชตมาสรุปเป็นไฟล์ `STATE.json` (ความคืบหน้าปัจจุบันและสิ่งที่ต้องทำต่อ)
- **6.3 Context Reset:** ล้างประวัติแชตทั้งหมดทิ้ง โหลด `STATE.json` เข้าไปใน System Prompt แล้วรันลูปการทำงานต่อ

---

## 5. Potential Risks & Mitigations (ความเสี่ยงและวิธีรับมือ)

| Risk                                                                      | Mitigation                                                                                                                                      |
| ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| **Agent Handover ล้มเหลว:** Agent ตัวใหม่เขียนทับโค้ดเดิมจนพัง            | กำหนด System Prompt ขา Handover ให้สั่ง Agent ตัวใหม่ว่า "Read files strictly before modifying" ควบคู่กับการใช้ Git ตรวจจับ Diff ก่อนยอมรับไฟล์ |
| **Terminal Scanner พลาด:** ไม่สามารถดักจับข้อความ Error จาก CLI ภายนอกได้ | ใช้ `node-pty` ควบคุมสตรีมอย่างละเอียด หรืออ่าน Exit Code ควบคู่กับ Text Stream เพื่อความแม่นยำ                                                 |
| **Gemma พยายามเขียนโค้ดเอง:** แทนที่จะสั่ง Agent ตัวอื่น                  | บังคับ Output ของ Gemma ให้เป็น JSON Schema ที่มีแค่ฟิลด์ `thought`, `target_agent`, และ `command_string`                                       |
