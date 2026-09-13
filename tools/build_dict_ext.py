# -*- coding: utf-8 -*-
"""
将 CC-CEDICT（MDBG 开源汉英词典）处理为插件可用的精简词库 dict-ext.json。
- 来源: https://www.mdbg.net/chinese/dictionary?page=cc-cedict  (CC BY-SA)
- 保留 2~6 字纯汉字词，取首条英文释义，过滤虚词/专名/标记词。
"""
import gzip
import json
import re
import sys

SRC = r"D:\WinDevelop\extension-LearnEnglish\tools\cedict.txt.gz"
OUT = r"D:\WinDevelop\extension-LearnEnglish\lib\dict-ext.json"

# 常见单字虚词/功能词（单字词整体不保留，此处仅用于说明；多字词中不受影响）
# 释义开头若命中以下标记则跳过（这些词条无实际替换价值）
BAD_DEF_PREFIX = (
    "surname", "old variant", "variant of", "see also",
    "abbreviation for", "abbreviation", "used in", "used as",
    "old name", "archaic", "CL:",
)
# 释义含词性标记 → 多为功能词，替换会破坏句子
BAD_DEF_MARKERS = (
    "pronoun", "particle", "auxiliary", "conjunction",
    "preposition", "interjection", "classifier", "measure word",
    "numeral", "modal", "prefix", "suffix",
)
# 常见多字功能词黑名单（代词/连词/介词/助词/副词/疑问/否定/判断/量词/数词等）
FUNCTION_WORDS = set("""
我们 你们 他们 她们 它们 咱们 自己 别人 大家 彼此 各自 本人 俺们 各位
这个 那个 这些 那些 这里 那里 这儿 那儿 这边 那边 这样 那样 这么 那么
什么 怎么 怎样 如何 为何 哪里 哪儿 哪些 哪个 谁 何时 几时 多少
我 你 他 她 它 您 咱 俺 吾 尔 汝 之 其 此 彼
因为 所以 但是 可是 然而 不过 虽然 即使 如果 假如 要是 倘若 既然 以免 哪怕
并且 而且 以及 与其 或者 还是 或是 不然 否则 何况 况且
和 与 或 及 并 而 且 但 若 如 因 故 虽 况
在 从 向 对 于 为 由 被 把 让 给 跟 比 朝 往 沿 顺 依 据 按 照 凭 趁 当 将 自 打
的 了 着 过 吗 呢 吧 啊 呀 哦 唉 嗯 哈 哟 嘛 呗 罢 么 呐 哩 咯 哇 嘢 啵 啦 诶 呵
之 所 者 也 矣 焉 乎 哉
地 得
们 些 个 次 条 张 本 只 件 块 台 辆 架 艘 颗 粒 朵 片 根 支 把 双 对 套 组 排 层 面 道 场 顿 份 篇 页 段 节 章 句 词 字 年 月 日 时 分 秒 点 刻 周 期 天
零 一 二 三 四 五 六 七 八 九 十 百 千 万 亿 两 几 半 多 少 数 若干
是 在 有 无 没 不 别 勿 莫 非 未 否 没准
都 很 更 最 太 也 还 又 再 就 才 只 仅 刚 正 已 曾 将 要 会 能 可 应 须 必 得
已经 正在 曾经 将要 刚刚 马上 立刻 立即 终于 突然 忽然 经常 总是 一直 永远 有时 偶尔 往往 常常 时常 再三 反复
非常 十分 特别 相当 比较 稍微 略微 几乎 大约 大概 差不多 至少 至多 最多 最少 仅仅 单单 白白 明明 偏偏 恰恰 正好 刚好
我们正在 你们好 大家好 你好 您好 谢谢 感谢 不客气 对不起 抱歉 没关系 再见 拜拜
可以 能够 可能 应该 应当 必须 需要 愿意 希望 想要 打算 准备 开始 继续 停止 结束 完成 进行
一起 一切 一些 一点 一定 一直 一样 一般 一生 一直 一起 一块 一道
上 下 中 内 外 前 后 左 右 东 西 南 北 旁 间 里 边 头 尾 顶 底
上面 下面 前面 后面 里面 外面 中间 旁边 左边 右边 上方 下方 上边 下边 里边 外边 前边 后边 左面 右面 内侧 外侧 正面 反面 侧面
一个 一次 一下 一会儿 一点儿 有些 有些 某个 某些 任何 每个 有的
没有 不是 不用 不要 别 不让 无法 难以 不可 不能 不会 不愿 不想 不做 不在 不再 不断 不停
通过 根据 按照 由于 除了 对于 为了 关于 作为 经由 依据 基于 本着 趁着 随着 顺着 沿着
第一 第二 第三 首先 其次 最后 然后 接着 同时 此外 另外 总之 例如 比如 譬如 所谓 尤其 甚至 乃至 以至 以致 因而 于是 从而 以便 以免
""".split())

# 首尾虚词（用于在线兜底候选过滤判断，content.js 另有精简版）
CN_RE = re.compile(r"[\u4e00-\u9fff]")
DIGIT_RE = re.compile(r"[0-9]")
WORD_RE = re.compile(r"^[\u4e00-\u9fff]{2,6}$")  # 仅 2~6 字纯汉字词

def parse_line(line):
    """CC-CEDICT 行: 传统 简体 [拼音] /释义1/释义2/"""
    if "[" not in line:
        return None
    head, rest = line.split("[", 1)
    if "]" not in rest:
        return None
    rest = rest.split("]", 1)[1].strip()
    if not rest.startswith("/"):
        return None
    defs = [d.strip() for d in rest.strip("/").split("/") if d.strip()]
    parts = head.strip().split()
    if len(parts) < 1:
        return None
    trad = parts[0]
    simp = parts[1] if len(parts) > 1 else trad
    return simp, defs

def clean_definition(d):
    """清洗单条释义，使其适合界面学习场景：
    1) 分号分隔的多个同义项只取第一项（如 center; heart; core → center）
    2) 去掉动词前缀 "to "（如 to test → test）
    3) 去掉括号注释（半角/全角，如 (machinery etc)）
    4) 去掉首尾空白与尾标点
    """
    d = d.strip()
    if not d:
        return None
    # 分号分隔同义项，只取第一项（全角分号一并处理）
    if ";" in d:
        d = d.split(";", 1)[0].strip()
    if "；" in d:
        d = d.split("；", 1)[0].strip()
    # 先去括号注释（含 (idiom) 等词性标记、嵌套括号），再处理动词前缀
    # 循环删除成对括号（处理嵌套如 (olivine (Mg,Fe)2SiO4)），再清除残留孤立括号字符
    while "(" in d or ")" in d or "（" in d or "）" in d:
        new = re.sub(r"[\(（][^)（）]*[\)）]", "", d)
        if new == d:
            break  # 只剩未配对的孤立括号字符
        d = new
    d = re.sub(r"[()（）]", "", d).strip()
    d = re.sub(r"\s{2,}", " ", d).strip()
    # 去掉开头 "to "（动词原形裸显示）
    if d.lower().startswith("to ") and len(d) > 3:
        d = d[3:].strip()
    # 去掉尾标点
    d = d.rstrip(".;，。:：")
    return d or None

def pick_definition(defs):
    """挑选一条可用的英文释义（先清洗，再按学习场景过滤）。"""
    for d in defs:
        if not d:
            continue
        low = d.lower()
        if low.startswith(BAD_DEF_PREFIX):
            continue
        if "cl:" in low.split(",")[0].lower() or low.split(",")[0].strip().startswith("cl:"):
            continue
        cleaned = clean_definition(d)
        if cleaned is None:
            continue
        if CN_RE.search(cleaned):
            continue
        clow = cleaned.lower()
        if clow.startswith(BAD_DEF_PREFIX):
            continue
        if any(m in clow for m in BAD_DEF_MARKERS):
            continue
        # 清洗后过短（只剩标点/助词等）
        if len(cleaned) < 2:
            continue
        return cleaned
    return None

def main():
    out = {}
    total = 0
    skipped = 0
    with gzip.open(SRC, "rt", encoding="utf-8") as f:
        for line in f:
            line = line.rstrip("\n")
            if not line or line.startswith("#"):
                continue
            parsed = parse_line(line)
            if parsed is None:
                skipped += 1
                continue
            simp, defs = parsed
            total += 1
            if not WORD_RE.match(simp):
                skipped += 1
                continue
            if DIGIT_RE.search(simp):
                skipped += 1
                continue
            if simp in FUNCTION_WORDS:
                skipped += 1
                continue
            en = pick_definition(defs)
            if en is None or len(en) > 28:
                skipped += 1
                continue
            if any(m in en.lower() for m in BAD_DEF_MARKERS):
                skipped += 1
                continue
            # 释义首字母小写化（英文普通词），专有名词保留
            if en[0].isupper() and not (len(en) > 2 and en[0].isupper() and en[1].islower()):
                pass  # 专有名词保留原样
            out[simp] = en

    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))

    size = len(json.dumps(out, ensure_ascii=False).encode("utf-8"))
    print(f"总词条(含过滤前): {total}")
    print(f"跳过: {skipped}")
    print(f"保留: {len(out)}")
    print(f"文件大小: {size/1024/1024:.2f} MB")

if __name__ == "__main__":
    main()
