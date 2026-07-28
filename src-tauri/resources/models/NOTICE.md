# Bundled Candle Whisper model notice

- Files: `whisper-tiny/model-tiny-q40.gguf`, `config-tiny.json`, and
  `tokenizer-tiny.json`
- Model: Whisper tiny, Q4_0 quantization, multilingual
- Model size: 23,252,000 bytes
- Model SHA-256: `330cbde1517a775d09df5c40a26c0b8caf531d9ceee3c17194f7a5707c43cda9`
- Quantized artifact source:
  https://huggingface.co/lmz/candle-whisper/resolve/02d8350e5402f18725eadb6101b4963d181b0b5e/model-tiny-q40.gguf
- Conversion repository: https://huggingface.co/lmz/candle-whisper
- Whisper source model: https://huggingface.co/openai/whisper-tiny
  (Apache-2.0 license)

`melfilters.bytes` is the 80-bin Whisper filter bank distributed with the
Hugging Face Candle 0.11 examples (Apache-2.0 OR MIT). It is used only for
local audio preprocessing.

The model pack is bundled for opt-in, on-device live captions. rLive does not
send captured audio or recognition output to a server.
