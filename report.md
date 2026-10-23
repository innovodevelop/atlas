# speech_embedding → ONNX

- Opset 15; ops: And, BatchNormalization, Conv, LeakyRelu, Less, Loop, Max, MaxPool, Relu, Reshape, Squeeze, Transpose, Unsqueeze
- ONNX vs TensorFlow, worst absolute difference: 4.39e-05

- App's mel framing: 5 frames per 1280-sample chunk (openWakeWord expects 8; with 480 samples of context: 8)

| clip | Google embeddings | oWW embeddings | median cosine | hey_jarvis (oWW) | hey_jarvis (Google) |
|---|---|---|---|---|---|
| noise | 28 | 28 | 0.957 | 0.000 | 0.000 |
| hey_jarvis_tts | 28 | 28 | 0.954 | 0.997 | 0.999 |
| other_speech_tts | 28 | 28 | 0.969 | 0.000 | 0.000 |
