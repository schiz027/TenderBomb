"""Server-owned minefields. Public snapshots never contain hidden cell contents."""

import math
import secrets
import time


CONFIG = {
    "express": (8, 8, 10, 5, 1),
    "state": (11, 12, 22, 6, 1),
    "registry": (16, 16, 48, 7, 2),
}


class SapperGame:
    def __init__(self, mode, rng=None, clock=None):
        self.mode = mode
        self.rows, self.cols, self.mine_count, self.event_every, self.fas_charges = CONFIG[mode]
        self.rng = rng or secrets.SystemRandom()
        self.clock = clock or time.monotonic
        self.started = None
        self.finished = None
        self.status = "ready"
        self.revision = 0
        self.event_meter = 0
        self.extract_charges = 0
        self.extract_authority = False
        self.extract_used = False
        self.logs = []
        self.cells = []
        for index in range(self.rows * self.cols):
            row, col = divmod(index, self.cols)
            self.cells.append({
                "index": index,
                "inactive": mode == "state" and row in (0, self.rows - 1) and col in (0, self.cols - 1),
                "mine": False, "extract": False, "revealed": False, "flagged": False,
                "hinted": False, "neutralized": False, "adjacent": 0,
            })

    def neighbors(self, index):
        row, col = divmod(index, self.cols)
        return [r * self.cols + c
                for r in range(max(0, row - 1), min(self.rows, row + 2))
                for c in range(max(0, col - 1), min(self.cols, col + 2))
                if r * self.cols + c != index and not self.cells[r * self.cols + c]["inactive"]]

    def generate(self, index):
        excluded = {index, *self.neighbors(index)}
        candidates = [c["index"] for c in self.cells if not c["inactive"] and c["index"] not in excluded]
        for mine in self.rng.sample(candidates, self.mine_count):
            self.cells[mine]["mine"] = True
        safe = [i for i in candidates if not self.cells[i]["mine"]]
        self.cells[self.rng.choice(safe) if safe else index]["extract"] = True
        self.recalculate()
        self.started = self.clock()
        self.status = "playing"

    def recalculate(self):
        for cell in self.cells:
            cell["adjacent"] = sum(self.cells[i]["mine"] for i in self.neighbors(cell["index"]))

    def log(self, title, text, tone="info"):
        self.logs.insert(0, {"title": title, "text": text, "tone": tone})
        del self.logs[9:]

    def open_cell(self, cell):
        if cell["revealed"]:
            return
        cell["revealed"] = True
        cell["hinted"] = False
        if cell["extract"]:
            self.extract_charges += 1
            self.extract_authority = True
            self.log("Выписка найдена", "Появилась точечная проверка поля.", "good")

    def open_region(self, index):
        pending = [index]
        while pending:
            cell = self.cells[pending.pop()]
            if cell["inactive"] or cell["mine"] or cell["revealed"] or cell["flagged"]:
                continue
            self.open_cell(cell)
            if not cell["adjacent"]:
                pending.extend(self.neighbors(cell["index"]))

    def choose(self, cells, count):
        return self.rng.sample(cells, min(count, len(cells)))

    def hint(self, count):
        chosen = self.choose([c for c in self.cells if c["mine"] and not c["flagged"] and not c["hinted"]], count)
        for cell in chosen:
            cell["hinted"] = True
        return len(chosen)

    def auto_open(self, count, single=False):
        safe = [c for c in self.cells if not c["inactive"] and not c["mine"]
                and not c["revealed"] and not c["flagged"] and (not single or not c["extract"])]
        before = self.revealed
        for cell in self.choose(safe, count):
            self.open_cell(cell) if single else self.open_region(cell["index"])
        return self.revealed - before

    def event(self):
        if not self.extract_authority and self.rng.random() < 0.24:
            self.extract_charges += 1
            self.extract_authority = True
            self.log("Выписка из реестра", "Документ нашелся. У отдела появился тяжелый аргумент.", "good")
            return
        event = self.rng.randrange(7)
        if event == 0:
            opened = self.auto_open(2)
            self.log("Запрос разъяснений", f"Заказчик раскрыл безопасные разделы: {opened}.")
        elif event == 1:
            self.hint(1)
            self.log("Срочная КП", "Поставщик подсветил подозрительный раздел.")
        elif event == 2:
            if self.rng.random() < 0.52:
                for cell in self.choose([c for c in self.cells if c["mine"] and not c["revealed"]], 1):
                    cell.update(mine=False, neutralized=True, hinted=False, flagged=False)
                self.recalculate()
                self.log("Внеплановая ФАС", "Один риск снят без лишних разговоров.", "good")
            else:
                self.hint(1)
                self.log("Внеплановая ФАС", "Письмо приняли, появился намек.", "warn")
        elif event == 3:
            self.hint(2)
            self.log("Эквивалент не допускается", "Формулировка выдала закрывашки рядом.", "bad")
        elif event == 4:
            self.auto_open(1)
            self.log("ТЗ на 186 страниц", "Один раздел стал понятнее после чтения.", "warn")
        elif event == 5:
            self.hint(1)
            self.log("Поставка вчера", "Сроки давят, один риск подсветился.", "bad")
        elif self.extract_authority:
            self.hint(1)
            self.auto_open(1, single=True)
            self.log("Один участник", "Выписка помогла подсветить риск и открыть безопасный раздел.", "good")
        else:
            self.auto_open(1)
            self.log("Один участник", "Тишина на площадке помогла открыть раздел.", "warn")

    @property
    def revealed(self):
        return sum(c["revealed"] and not c["mine"] for c in self.cells)

    @property
    def flags(self):
        return sum(c["flagged"] for c in self.cells)

    def action(self, action, index=None):
        if self.status in ("won", "lost"):
            return "round_finished"
        if action not in ("reveal", "flag", "fas", "extract"):
            return "invalid_action"
        if action != "extract" and (type(index) is not int or not 0 <= index < len(self.cells) or self.cells[index]["inactive"]):
            return "bad_cell"
        if action == "flag":
            cell = self.cells[index]
            if cell["revealed"]:
                return "bad_cell"
            cell["flagged"] = not cell["flagged"]
            cell["hinted"] = False
        elif action == "reveal":
            cell = self.cells[index]
            if cell["revealed"] or cell["flagged"]:
                return "bad_cell"
            if self.started is None:
                self.generate(index)
            if cell["mine"]:
                self.status = "lost"
                self.finished = self.clock()
            else:
                self.open_region(index)
                self.event_meter += 1
                if self.event_meter >= self.event_every:
                    self.event_meter = 0
                    self.event()
        elif self.status != "playing":
            return "round_not_started"
        elif action == "fas":
            if self.fas_charges <= 0:
                return "no_charges"
            self.fas_charges -= 1
            before = self.revealed
            hinted = 0
            for i in [index, *self.neighbors(index)]:
                cell = self.cells[i]
                if cell["flagged"] or cell["revealed"]:
                    continue
                if cell["mine"]:
                    cell["hinted"] = True
                    hinted += 1
                else:
                    self.open_region(i)
            self.log("Проверка ФАС", f"Подсвечено рисков: {hinted}, открыто безопасных: {self.revealed - before}.", "good")
        else:
            if self.extract_charges <= 0:
                return "no_charges"
            self.extract_charges -= 1
            self.extract_used = True
            self.extract_authority = True
            hinted, opened = self.hint(1), self.auto_open(1, single=True)
            self.log("Выписка РФ", f"Подсвечено рисков: {hinted}, открыт безопасный раздел: {opened}.", "good")
        if self.status == "playing" and all(c["inactive"] or c["mine"] or c["revealed"] for c in self.cells):
            self.status = "won"
            self.finished = self.clock()
            for cell in self.cells:
                if cell["mine"]:
                    cell["flagged"] = True
        self.revision += 1
        return None

    def elapsed_ms(self):
        return 0 if self.started is None else max(0, math.floor(((self.finished if self.finished is not None else self.clock()) - self.started) * 1000))

    def snapshot(self):
        cells = []
        for cell in self.cells:
            public = {key: cell[key] for key in ("index", "inactive", "revealed", "flagged", "hinted")}
            public.update(
                mine=cell["mine"] if self.status == "lost" else False,
                adjacent=cell["adjacent"] if cell["revealed"] else 0,
                extract=cell["extract"] if cell["revealed"] else False,
                neutralized=cell["neutralized"] if cell["revealed"] else False,
            )
            cells.append(public)
        return {
            "cells": cells, "status": self.status, "firstMove": self.started is None,
            "flags": self.flags, "revealed": self.revealed, "elapsed_ms": self.elapsed_ms(),
            "mineCount": sum(c["mine"] for c in self.cells) if self.started is not None else self.mine_count,
            "fasCharges": self.fas_charges, "extractCharges": self.extract_charges,
            "extractAuthority": self.extract_authority, "extractUsed": self.extract_used,
            "eventMeter": self.event_meter, "revision": self.revision, "logs": self.logs,
        }
