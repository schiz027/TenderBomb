"""Authoritative tank simulation; clients supply controls, never scores or physics."""

import math
import secrets
import time


TILE, GRID, SIZE, TANK = 32, 16, 512, 24
BASE_COL, BASE_ROW = 7, 15
DIRS = {"up": (0, -1), "down": (0, 1), "left": (-1, 0), "right": (1, 0)}


def overlap(a, b):
    return a["x"] < b["x"] + b["w"] and a["x"] + a["w"] > b["x"] and a["y"] < b["y"] + b["h"] and a["y"] + a["h"] > b["y"]


def base_rect():
    return {"x": BASE_COL * TILE + 4, "y": BASE_ROW * TILE + 4, "w": TANK, "h": TANK}


class TanksGame:
    def __init__(self, god=False, rng=None, clock=None):
        self.rng = rng or secrets.SystemRandom()
        self.clock = clock or time.monotonic
        self.last_time = self.clock()
        self.carry = 0.0
        self.ticks = 0
        self.seq = 0
        self.next_id = 0
        self.controls = {"direction": None, "fire": False}
        self.god = god
        self.ranked = not god
        self.reason = None
        self.state = {
            "status": "playing", "level": 1, "score": 0, "lives": 3, "destroyed": 0,
            "doubleShot": False, "plasmaShot": False, "plasmaArmor": False,
            "fastEnemiesUnlocked": False, "iceUnlocked": False, "elapsedSeconds": 0,
            "log": [], "effects": [], "bullets": [], "powerups": [],
        }
        self.log("Старт", "База вышла на оборону.")
        self.start_level()

    def actor(self, **values):
        self.next_id += 1
        return {"id": self.next_id, **values}

    def log(self, title, text, tone="info"):
        self.state["log"].insert(0, {"title": title, "text": text, "tone": tone})
        del self.state["log"][12:]

    def effect(self, x, y, kind):
        self.state["effects"].append(self.actor(x=x, y=y, kind=kind, life=24, maxLife=24, age=0))

    def player(self):
        return self.actor(x=132, y=450, w=TANK, h=TANK, dir="up", cooldown=0, invuln=90, sliding=False)

    def protected(self, row, col):
        return (row <= 2 and (col <= 2 or col >= 13 or abs(col - 7) <= 2)
                or row >= 11 and abs(col - 7) <= 3
                or 13 <= row <= 14 and 2 <= col <= 6)

    def place(self, row, col, value, mirrored=False):
        for c in (col, GRID - 1 - col) if mirrored else (col,):
            if 0 <= row < GRID and 0 <= c < GRID and not self.protected(row, c):
                self.state["map"][row][c] = value

    def clear(self, top, bottom, left, right):
        for row in range(max(0, top), min(GRID - 1, bottom) + 1):
            for col in range(max(0, left), min(GRID - 1, right) + 1):
                if self.state["map"][row][col] != 3:
                    self.state["map"][row][col] = 0

    def start_level(self):
        s, level = self.state, self.state["level"]
        s.update(status="playing", map=[[0] * GRID for _ in range(GRID)], player=self.player(),
                 enemies=[], bullets=[], powerups=[], effects=[], iceUnlocked=level >= 4,
                 spawned=0, totalEnemies=min(40, 6 + level * 2), spawnCooldown=0, waveDelay=0)
        s["enemiesLeft"] = s["totalEnemies"]
        for rows, cols, threshold in ((range(2, 6), (1, 3, 5), .28), (range(9, 13), (1, 4, 6), .34)):
            for row in rows:
                for col in cols:
                    if self.rng.random() > threshold:
                        self.place(row, col, 1, True)
        for row, col in ((4, 7), (6, 2), (7, 4), (8, 6), (10, 3), (11, 5)):
            self.place(row, col, 2, True)
        if level >= 5:
            for _ in range(2 + level // 3):
                if self.rng.random() > .45:
                    row, col = self.rng.randrange(3, 11), self.rng.randrange(2, 14)
                    if s["map"][row][col] == 0:
                        self.place(row, col, 2, True)
        if level >= 4:
            for _ in range(2 + level // 4):
                if self.rng.random() > .3:
                    row, col = self.rng.randrange(4, 11), self.rng.randrange(3, 13)
                    if s["map"][row][col] == 0:
                        self.place(row, col, 5, True)
        for col in range(2, 14):
            if col in (7, 8):
                continue
            for row, chance in ((7, .76), (9, .8)):
                if self.rng.random() > chance:
                    self.place(row, col, 1)
        for col in (0, 7, 15):
            self.clear(0, 1, col - 1, col + 1)
        self.clear(13, 14, 3, 5)
        self.clear(13, 15, 5, 9)
        for row, col in ((14, 6), (14, 7), (14, 8), (15, 6), (15, 8)):
            s["map"][row][col] = 1
        for row, col in ((13, 7), *((13, c) for c in (5, 9) if level >= 3)):
            s["map"][row][col] = 2
        s["map"][15][7] = 3
        if level >= 2:
            target = 3 if level >= 3 else 2 + int(self.rng.random() > .45)
            for _ in range(300):
                if target <= 0:
                    break
                row, col = self.rng.randrange(3, 12), self.rng.randrange(2, 14)
                if not s["map"][row][col] and not self.protected(row, col):
                    s["map"][row][col] = 4
                    target -= 1
        for enabled, kind, row, col in ((level >= 5 and not s["plasmaShot"], "plasma", 6, 8),
                                         (level >= 3 and not s["doubleShot"], "double", 10, 8),
                                         (level >= 8, "freeze", 7, 4)):
            if enabled:
                self.clear(row - 1, row + 1, col - 1, col + 1)
                s["powerups"].append(self.actor(type=kind, x=col * TILE + 4, y=row * TILE + 4, w=24, h=24, age=0))
        self.log(f"Уровень {level}", f"Вражеская волна: {s['totalEnemies']}.")

    def advance(self, god=False):
        current = self.clock()
        elapsed = max(0, current - self.last_time)
        self.last_time = current
        self.god = god
        if god:
            self.ranked = False
        if self.state["status"] in ("paused", "gameover"):
            return
        # Lost clients cannot leave a held fire key running unattended indefinitely.
        if elapsed > 5:
            self.ranked = False
            self.finish("disconnected")
            return
        self.carry += elapsed * 60
        steps = int(self.carry)
        self.carry -= steps
        for _ in range(steps):
            if self.state["status"] == "gameover":
                break
            self.ticks += 1
            self.step()
        self.state["elapsedSeconds"] = max(1 if self.state["status"] == "gameover" else 0, self.ticks // 60)

    def control(self, action, direction=None, fire=False):
        s = self.state
        if action == "cancel":
            self.ranked = False
            self.finish("closed")
        elif action == "finish":
            self.finish("closed")
        elif action == "pause" and s["status"] in ("playing", "wave-clear"):
            s["resumeStatus"] = s["status"]
            s["status"] = "paused"
            self.controls = {"direction": None, "fire": False}
        elif action == "resume" and s["status"] == "paused":
            s["status"] = s.get("resumeStatus", "playing")
        elif action == "input":
            self.controls = {"direction": direction if isinstance(direction, str) and direction in DIRS else None, "fire": fire is True}

    def finish(self, reason):
        if self.state["status"] == "gameover":
            return
        self.reason = reason
        self.state["status"] = "gameover"
        self.state["elapsedSeconds"] = max(1, self.ticks // 60)
        text = {"base": "База пробита.", "lives": "Танк потерян.", "disconnected": "Связь с игроком потеряна."}.get(reason, "Раунд остановлен.")
        self.log("Финиш", f"{text} Уровень {self.state['level']}, очки: {self.state['score']}.", "bad")

    def solid(self, rect):
        if rect["x"] < 0 or rect["y"] < 0 or rect["x"] + rect["w"] > SIZE or rect["y"] + rect["h"] > SIZE:
            return True
        for row in range(int(rect["y"] // TILE), int((rect["y"] + rect["h"] - 1) // TILE) + 1):
            for col in range(int(rect["x"] // TILE), int((rect["x"] + rect["w"] - 1) // TILE) + 1):
                if self.state["map"][row][col] in (1, 2, 3, 4):
                    return True
        return False

    def tanks_hit(self, rect, tank):
        return any(other is not tank and overlap(rect, other)
                   for other in [self.state["player"], *self.state["enemies"]] if other)

    def probe(self, tank, direction, distance):
        dx, dy = DIRS[direction]
        return {**tank, "x": tank["x"] + dx * distance, "y": tank["y"] + dy * distance}

    def can_move(self, tank, direction, distance):
        rect = self.probe(tank, direction, distance)
        return not self.solid(rect) and not self.tanks_hit(rect, tank)

    def move(self, tank, distance):
        rect = self.probe(tank, tank["dir"], distance)
        rect["x"] = max(0, min(SIZE - tank["w"], rect["x"]))
        rect["y"] = max(0, min(SIZE - tank["h"], rect["y"]))
        if self.solid(rect) or self.tanks_hit(rect, tank):
            return False
        tank.update(x=math.floor(rect["x"] * 10 + .5) / 10, y=math.floor(rect["y"] * 10 + .5) / 10)
        return True

    def tile(self, x, y):
        row, col = math.floor(y / TILE), math.floor(x / TILE)
        return (row, col, self.state["map"][row][col]) if 0 <= row < GRID and 0 <= col < GRID else None

    def ice(self, tank):
        tile = self.tile(tank["x"] + tank["w"] / 2, tank["y"] + tank["h"] / 2)
        return bool(tile and tile[2] == 5)

    def fire(self, tank, owner):
        if tank["cooldown"] > 0:
            return
        dx, dy = DIRS[tank["dir"]]
        for offset in (-5, 5) if owner == "player" and self.state["doubleShot"] else (0,):
            self.state["bullets"].append(self.actor(
                x=tank["x"] + 12 + dx * 15 + (offset if dx == 0 else 0),
                y=tank["y"] + 12 + dy * 15 + (offset if dy == 0 else 0),
                dx=dx, dy=dy, dir=tank["dir"], speed=5.8 if owner == "player" else 5.8 * .84,
                owner=owner, life=math.ceil((SIZE + TILE) / 5.8)))
        tank["cooldown"] = 19 if owner == "player" else 58 - min(22, self.state["level"] * 2)

    def spawn(self):
        s, level = self.state, self.state["level"]
        if s["spawned"] >= s["totalEnemies"] or len(s["enemies"]) >= min(5, 2 + level // 2):
            return
        s["spawnCooldown"] -= 1
        if s["spawnCooldown"] > 0:
            return
        for _ in range(10):
            enemy = self.actor(x=self.rng.randrange(GRID) * TILE + 4, y=4, w=TANK, h=TANK)
            if self.solid(enemy) or self.tanks_hit(enemy, None):
                continue
            kind = "fast" if level >= 5 and s["fastEnemiesUnlocked"] and self.rng.random() < .4 else "normal"
            if kind == "normal" and level % 4 == 0 and self.rng.random() < .35:
                kind = "heavy"
            enemy.update(dir="down", speed=(1.9 if kind == "fast" else 1.08) + min(1.1, level * .035),
                         cooldown=40 + self.rng.random() * 45, turnTimer=18 + self.rng.random() * 70,
                         type=kind, hp=2 if kind == "heavy" else 1, wobble=self.rng.random() * 100, sliding=False)
            s["enemies"].append(enemy)
            s["spawned"] += 1
            s["spawnCooldown"] = max(18, 66 - level * 2)
            return

    def enemy_direction(self, enemy, forced=False):
        base_bias = .38 if self.state["level"] == 1 else .68
        target = base_rect() if self.rng.random() < base_bias or forced else self.state["player"]
        horizontal = "left" if target["x"] < enemy["x"] else "right"
        vertical = "up" if target["y"] < enemy["y"] else "down"
        preferred = vertical if self.rng.random() < .58 else horizontal
        return next((direction for direction in (preferred, vertical, horizontal, "down", "left", "right", "up")
                     if self.can_move(enemy, direction, enemy["speed"] * 4)), self.rng.choice(tuple(DIRS)))

    def hit_player(self):
        s, player = self.state, self.state["player"]
        if self.god or s["plasmaArmor"]:
            player["invuln"] = 80
            if not self.god:
                s["plasmaArmor"] = False
                self.log("Щит пробит", "Плазменный щит разрушен.", "warn")
            return
        s["lives"] -= 1
        self.effect(player["x"] + 12, player["y"] + 12, "blast")
        if s["lives"] <= 0:
            self.finish("lives")
        else:
            s["player"] = self.player()
            s["player"]["invuln"] = 120
            self.log("Попадание", f"Жизни: {s['lives']}.", "warn")

    def bullet_tile(self, bullet, tile):
        row, col, value = tile
        s, own = self.state, bullet["owner"] == "player"
        if value == 3:
            self.finish("base")
        elif value in (1, 4) or value == 2 and own and s["plasmaShot"]:
            s["map"][row][col] = 0
            if own:
                s["score"] += {1: 2 if s["iceUnlocked"] else 4, 2: 15, 4: 20}[value]
            if value == 4:
                s["powerups"].append(self.actor(type="life", x=col * TILE + 5, y=row * TILE + 5, w=22, h=22, age=0))
                self.log("Ящик разбит", "Выпало сердечко.", "good")
        self.effect(col * TILE + 16, row * TILE + 16, "crate" if value == 4 else "brick" if value == 1 else "steel")

    def bullets(self):
        s = self.state
        for bullet in s["bullets"]:
            bullet["x"] += bullet["dx"] * bullet["speed"]
            bullet["y"] += bullet["dy"] * bullet["speed"]
            bullet["life"] -= 1
        for bullet in list(reversed(s["bullets"])):
            remove = bullet["life"] <= 0 or not -8 <= bullet["x"] <= SIZE + 8 or not -8 <= bullet["y"] <= SIZE + 8
            tile = self.tile(bullet["x"], bullet["y"])
            if not remove and tile and tile[2]:
                self.bullet_tile(bullet, tile)
                remove = True
            rect = {"x": bullet["x"] - 3, "y": bullet["y"] - 3, "w": 6, "h": 6}
            if not remove and bullet["owner"] == "player":
                enemy = next((e for e in s["enemies"] if overlap(rect, e)), None)
                if enemy:
                    remove = True
                    enemy["hp"] -= 1
                    self.effect(enemy["x"] + 12, enemy["y"] + 12, "hit")
                    if enemy["hp"] <= 0:
                        s["enemies"].remove(enemy)
                        s["enemiesLeft"] = max(0, s["enemiesLeft"] - 1)
                        s["destroyed"] += 1
                        s["score"] += 230 + s["level"] * 24 if enemy["type"] == "heavy" else 120 + s["level"] * 18
                        self.effect(enemy["x"] + 12, enemy["y"] + 12, "blast")
            elif not remove and s["player"]["invuln"] <= 0 and overlap(rect, s["player"]):
                self.hit_player()
                remove = True
            if remove:
                s["bullets"].remove(bullet)
            if s["status"] == "gameover":
                return

    def powerups(self):
        s = self.state
        for powerup in list(s["powerups"]):
            powerup["age"] += 1
            if not overlap(powerup, s["player"]):
                continue
            kind = powerup["type"]
            if kind == "life":
                s["lives"] += 1
                s["score"] += 80 + s["level"] * 12
                self.log("Сердечко", f"Жизни: {s['lives']}.", "good")
            elif kind == "double":
                s["doubleShot"] = True
                s["score"] += 180
                self.log("Апгрейд", "Двойной ствол активирован.", "good")
            elif kind == "plasma":
                s.update(plasmaShot=True, plasmaArmor=True, fastEnemiesUnlocked=True)
                s["score"] += 350
                self.log("Плазма", "Снаряды пробивают сталь. Щит активирован.", "good")
            elif kind == "freeze":
                s["score"] += 250
                for enemy in s["enemies"]:
                    enemy["frozen"] = 180
                self.log("Заморозка", "Все враги на поле обездвижены.", "good")
            self.effect(powerup["x"] + 12, powerup["y"] + 12, "heart" if kind == "life" else "upgrade")
            s["powerups"].remove(powerup)

    def step(self):
        s = self.state
        if s["status"] == "wave-clear":
            s["waveDelay"] -= 1
            if s["waveDelay"] <= 0:
                s["level"] += 1
                self.start_level()
            return
        self.spawn()
        player = s["player"]
        player["cooldown"] = max(0, player["cooldown"] - 1)
        player["invuln"] = max(0, player["invuln"] - 1)
        player["sliding"] = self.ice(player)
        direction = self.controls["direction"]
        if direction and not player["sliding"]:
            player["dir"] = direction
        if direction or player["sliding"]:
            self.move(player, 2.05)
        if self.controls["fire"]:
            self.fire(player, "player")
        self.powerups()
        for enemy in s["enemies"]:
            enemy["cooldown"] = max(0, enemy["cooldown"] - 1)
            if enemy.get("frozen", 0) > 0:
                enemy["frozen"] -= 1
                continue
            enemy["turnTimer"] -= 1
            enemy["sliding"] = self.ice(enemy)
            if enemy["turnTimer"] <= 0 and not enemy["sliding"]:
                enemy["dir"] = self.enemy_direction(enemy)
                enemy["turnTimer"] = 28 + self.rng.random() * 80
            if not self.move(enemy, enemy["speed"]) and not enemy["sliding"]:
                enemy["dir"] = self.enemy_direction(enemy, True)
                enemy["turnTimer"] = 22 + self.rng.random() * 44
            if enemy["cooldown"] <= 0 and self.rng.random() < .026 + s["level"] * .002:
                target = base_rect() if self.rng.random() < (.24 if s["level"] == 1 else .55) else s["player"]
                dx, dy = target["x"] - enemy["x"], target["y"] - enemy["y"]
                enemy["dir"] = ("left" if dx < 0 else "right") if abs(dx) > abs(dy) else ("up" if dy < 0 else "down")
                enemy["turnTimer"] = 16
                self.fire(enemy, "enemy")
        self.bullets()
        for effect in s["effects"]:
            effect["life"] -= 1
            effect["age"] += 1
        s["effects"] = [effect for effect in s["effects"] if effect["life"] > 0]
        if s["status"] == "playing" and s["spawned"] >= s["totalEnemies"] and not s["enemies"] and s["enemiesLeft"] <= 0:
            s.update(status="wave-clear", waveDelay=95)
            bonus = s["level"] * 240 + s["lives"] * 120
            s["score"] += bonus
            self.log("Волна отбита", f"Бонус {bonus}.", "good")

    def snapshot(self):
        return {**self.state, "seq": self.seq, "ranked": self.ranked, "godMode": self.god}
