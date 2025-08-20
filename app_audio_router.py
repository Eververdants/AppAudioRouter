# -*- coding: utf-8 -*-
import csv
import json
import os
import sys
import time
import tempfile
import subprocess
from typing import List, Tuple, Optional, Dict

import psutil
from PyQt5 import QtWidgets, QtCore, QtGui
from pycaw.pycaw import AudioUtilities

CONFIG_PATH = os.path.join(os.path.dirname(os.path.abspath(sys.argv[0])), 'app_audio_router.config.json')

# ------------------------- SoundVolumeView 后端封装 -------------------------
class SVVBackend:
    """封装对 NirSoft SoundVolumeView 的调用（稳定，不依赖未公开的 COM 接口）。"""

    def __init__(self) -> None:
        self.exe = self._find_exe()

    @staticmethod
    def _find_exe() -> Optional[str]:
        names = [
            'svcl.exe',                 # 命令行版（若有）
            'SoundVolumeView.exe',     # GUI 版也支持命令行
        ]
        here = os.path.dirname(os.path.abspath(sys.argv[0]))
        for n in names:
            p = os.path.join(here, n)
            if os.path.isfile(p):
                return p
        for n in names:
            p = os.path.join(os.getcwd(), n)
            if os.path.isfile(p):
                return p
        for n in names:
            p = which(n)
            if p:
                return p
        return None

    def ensure_available(self) -> Tuple[bool, str]:
        if self.exe and os.path.isfile(self.exe):
            return True, self.exe
        return False, (
            '未找到 SoundVolumeView.exe（或 svcl.exe）。请从 NirSoft 下载并将 exe 放到本脚本同目录或加入 PATH。'
        )

    def list_render_devices(self) -> List[Dict[str, str]]:
        """返回渲染（输出）设备列表：[{"id": cmd-friendly-id, "name": friendly-name}]"""
        ok, msg = self.ensure_available()
        if not ok:
            raise RuntimeError(msg)
        tmp = tempfile.NamedTemporaryFile(delete=False, suffix='.csv')
        tmp_path = tmp.name
        tmp.close()
        try:
            cmd = [self.exe, '/scomma', tmp_path, '/Columns', 'Command-Line Friendly ID,Name,Type,Direction']
            subprocess.run(cmd, capture_output=True, shell=False)
            with open(tmp_path, 'rb') as f:
                raw = f.read()
            text = try_decode(raw)
            rows = list(csv.reader(text.splitlines()))
            if not rows:
                return []
            header = rows[0]
            colmap = {name: idx for idx, name in enumerate(header)}
            need = ['Command-Line Friendly ID', 'Name', 'Type', 'Direction']
            if not all(k in colmap for k in need):
                raise RuntimeError('SoundVolumeView 导出列不完整，无法解析。')
            devices: List[Dict[str, str]] = []
            for r in rows[1:]:
                try:
                    if r[colmap['Type']].strip() == 'Device' and r[colmap['Direction']].strip() == 'Render':
                        devices.append({'id': r[colmap['Command-Line Friendly ID']].strip(), 'name': r[colmap['Name']].strip()})
                except Exception:
                    continue
            uniq: Dict[str, Dict[str, str]] = {d['id']: d for d in devices}
            return sorted(uniq.values(), key=lambda x: (x['name'].lower(), x['id'].lower()))
        finally:
            try:
                os.remove(tmp_path)
            except Exception:
                pass

    def set_app_default(self, device_id: str, target: str, role: str = 'all') -> Tuple[bool, str]:
        ok, msg = self.ensure_available()
        if not ok:
            return False, msg
        if role not in ('0', '1', '2', 'all'):
            role = 'all'
        cmd = [self.exe, '/SetAppDefault', device_id, role, target]
        run = subprocess.run(cmd, capture_output=True, shell=False)
        if run.returncode == 0:
            return True, '已完成。'
        err = (run.stderr or b'').decode(errors='ignore') if isinstance(run.stderr, (bytes, bytearray)) else (run.stderr or '')
        out = (run.stdout or b'').decode(errors='ignore') if isinstance(run.stdout, (bytes, bytearray)) else (run.stdout or '')
        return False, f'设置失败（exit={run.returncode}）\nSTDOUT: {out}\nSTDERR: {err}'

# ------------------------- 移除 pycaw 会话工具（音量/静音） -------------------------
# 音量控制功能已移除

# ------------------------- 移除监听线程（WASAPI Loopback） -------------------------
# 监听功能已移除

# ------------------------------- PyQt5 UI -------------------------------
class AudioRouterUI(QtWidgets.QWidget):
    def __init__(self):
        super().__init__()
        self.setWindowTitle('App Audio Router（每应用音频路由）')
        self.resize(860, 560)
        icon_path = os.path.join(os.path.dirname(os.path.abspath(sys.argv[0])), 'favicon.ico')
        if os.path.exists(icon_path):
            self.setWindowIcon(QtGui.QIcon(icon_path))

        self.svv = SVVBackend()
        self._last_route_device_name: Optional[str] = None  # 记录最近一次路由的设备友好名

        # 顶部区域：进程 + 设备 + 角色
        self.procCombo = QtWidgets.QComboBox()
        self.procCombo.setEditable(False)
        self.btnRefreshProc = QtWidgets.QPushButton('刷新进程')

        self.deviceCombo = QtWidgets.QComboBox()
        self.deviceCombo.setEditable(False)
        self.btnRefreshDev = QtWidgets.QPushButton('刷新设备')

        self.roleCombo = QtWidgets.QComboBox()
        self.roleCombo.addItems(['全部(all)', 'Console(0)', 'Multimedia(1)', 'Communications(2)'])

        self.btnApply = QtWidgets.QPushButton('路由到此设备 ▶')

        # 移除监听和音量控制相关UI元素

        # 自动记忆
        self.chkAutoApply = QtWidgets.QCheckBox('自动记忆并套用给该进程（按可执行名）')
        self._route_map: Dict[str, str] = self._load_config()

        # 日志
        self.statusText = QtWidgets.QPlainTextEdit()
        self.statusText.setReadOnly(True)
        self.statusText.setMaximumBlockCount(2000)

        # —— 布局 ——
        form = QtWidgets.QFormLayout()
        form.addRow('选择进程：', self._hline(self.procCombo, self.btnRefreshProc))
        form.addRow('选择输出设备：', self._hline(self.deviceCombo, self.btnRefreshDev))
        form.addRow('默认类型：', self.roleCombo)
        form.addRow(self.btnApply)

        # 移除监听和音量控制相关UI布局

        v = QtWidgets.QVBoxLayout(self)
        v.addLayout(form)
        v.addWidget(self.chkAutoApply)
        v.addWidget(QtWidgets.QLabel('日志：'))
        v.addWidget(self.statusText, 1)

        # —— 信号 ——
        self.btnRefreshProc.clicked.connect(self.reload_processes)
        self.btnRefreshDev.clicked.connect(self.reload_devices)
        self.btnApply.clicked.connect(self.apply_route)

        # 初始化
        self.reload_processes()
        self.reload_devices()

        # 定时器：会话刷新 & 自动套用
        self._timer = QtCore.QTimer(self)
        self._timer.timeout.connect(self._tick)
        self._timer.start(3000)

    # -------------------- 持久化 --------------------
    def _load_config(self) -> Dict[str, str]:
        if os.path.isfile(CONFIG_PATH):
            try:
                with open(CONFIG_PATH, 'r', encoding='utf-8') as f:
                    return json.load(f)
            except Exception:
                return {}
        return {}

    def _save_config(self):
        try:
            with open(CONFIG_PATH, 'w', encoding='utf-8') as f:
                json.dump(self._route_map, f, ensure_ascii=False, indent=2)
        except Exception as e:
            self._log(f'保存配置失败：{e}')

    # -------------------- UI 构件 --------------------
    def _hline(self, *widgets: QtWidgets.QWidget) -> QtWidgets.QWidget:
        w = QtWidgets.QWidget()
        h = QtWidgets.QHBoxLayout(w)
        h.setContentsMargins(0, 0, 0, 0)
        for x in widgets:
            h.addWidget(x)
        h.addStretch(1)
        return w

    # -------------------- 数据加载 --------------------
    def reload_processes(self):
        self.procCombo.clear()
        sessions = AudioUtilities.GetAllSessions()
        seen: set[int] = set()
        items: List[Tuple[str, int, str]] = []  # (name, pid, exe)
        for s in sessions:
            try:
                p = s.Process
                if p is None:
                    continue
                pid = getattr(p, 'pid', None) or (p.id() if hasattr(p, 'id') else None)
                if pid is None or pid in seen:
                    continue
                seen.add(pid)
                try:
                    name = p.name() if hasattr(p, 'name') else psutil.Process(pid).name()
                except Exception:
                    name = f'PID {pid}'
                items.append((name, pid, name))
            except Exception:
                continue
        items.sort(key=lambda x: (x[0].lower(), x[1]))
        if not items:
            self._log('未检测到有音频会话的进程。提示：请先让目标程序发出声音，然后点击“刷新进程”。')
        for name, pid, exe in items:
            self.procCombo.addItem(f'{name}  (PID {pid})', (pid, exe))
        self._log(f'进程列表已刷新（{len(items)} 项）。')

    def reload_devices(self):
        self.deviceCombo.clear()
        ok, msg = self.svv.ensure_available()
        if not ok:
            QtWidgets.QMessageBox.warning(self, '需要 SoundVolumeView', msg)
            self._log(msg)
            return
        try:
            devices = self.svv.list_render_devices()
        except Exception as e:
            QtWidgets.QMessageBox.critical(self, '设备枚举失败', str(e))
            self._log(f'设备枚举失败：{e}')
            return
        if not devices:
            self._log('未获取到任何输出设备。')
        for dev in devices:
            self.deviceCombo.addItem(f"{dev['name']}  [{dev['id']}]", (dev['id'], dev['name']))
        self._log(f'设备列表已刷新（{len(devices)} 项）。')

    # 监听输出设备枚举功能已移除

    # -------------------- 定时循环 --------------------
    def _tick(self):
        # 自动套用：如果开启了自动记忆，则对在列表中的 exe 重复调用设置（幂等）
        if self.chkAutoApply.isChecked() and self._route_map:
            sessions = AudioUtilities.GetAllSessions()
            for s in sessions:
                try:
                    if not s.Process:
                        continue
                    pid = s.Process.pid
                    exe = s.Process.name()
                    if exe in self._route_map:
                        dev_id = self._route_map[exe]
                        self.svv.set_app_default(dev_id, str(pid), role='all')
                except Exception:
                    continue

    # -------------------- 操作 --------------------
    def apply_route(self):
        idx_p = self.procCombo.currentIndex()
        idx_d = self.deviceCombo.currentIndex()
        if idx_p < 0 or idx_d < 0:
            self._log('请选择进程与设备。')
            return
        (pid, exe) = self.procCombo.itemData(idx_p)
        (dev_id, dev_name) = self.deviceCombo.itemData(idx_d)
        role_text = self.roleCombo.currentText()
        role = 'all'
        if '(0)' in role_text:
            role = '0'
        elif '(1)' in role_text:
            role = '1'
        elif '(2)' in role_text:
            role = '2'

        if not psutil.pid_exists(pid):
            self._log(f'PID {pid} 不存在，已退出？请刷新进程列表。')
            return

        ok, msg = self.svv.set_app_default(device_id=dev_id, target=str(pid), role=role)
        if ok:
            self._log(f'✅ 已将 PID {pid} 路由到：{dev_name}（role={role}）。')
            self._last_route_device_name = dev_name
            if self.chkAutoApply.isChecked() and exe:
                self._route_map[exe] = dev_id
                self._save_config()
                # 监听功能已移除
        else:
            self._log('❌ 设置失败：\n' + msg)

    # 监听功能已移除

    # 音量控制功能已移除

    # -------------------- 辅助 --------------------
    def _log(self, s: str):
        ts = time.strftime('%H:%M:%S')
        self.statusText.appendPlainText(f'[{ts}] {s}')

# -------------------- 工具函数 --------------------
def which(name: str) -> Optional[str]:
    paths = os.environ.get('PATH', '').split(os.pathsep)
    exts = ['.exe', '.bat', '.cmd', '']
    for p in paths:
        full = os.path.join(p, name)
        if os.path.isfile(full):
            return full
        for ext in exts:
            f = full + ext
            if os.path.isfile(f):
                return f
    return None


def try_decode(b: bytes) -> str:
    for enc in ('utf-8-sig', 'utf-8', 'utf-16', 'utf-16le', 'utf-16be', 'mbcs', 'cp1252', 'gbk'):
        try:
            return b.decode(enc)
        except Exception:
            continue
    return b.decode(errors='replace')

# ------------------------------- 入口 -------------------------------
if __name__ == '__main__':
    app = QtWidgets.QApplication(sys.argv)
    ui = AudioRouterUI()
    ui.show()
    sys.exit(app.exec_())
