# WALLY 本地手动目标。
#
# 语音基线需要麦克风/喇叭，**不进 push CI**（run-gates.sh 里没有它）；
# 这里的单测是纯逻辑、无硬件的，可以随时跑。
.PHONY: help voice-baseline voice-baseline-test

help:
	@printf 'make voice-baseline        # 跑语音回归基线（需要 Mac 麦克风/喇叭；输出 eval/voice/runs/*.json）\n'
	@printf 'make voice-baseline-test   # 只跑基线的纯逻辑单测（不需要硬件）\n'

voice-baseline:
	sh eval/voice/run_baseline.sh

voice-baseline-test:
	python3 -m unittest discover -s eval/voice/tests -v
