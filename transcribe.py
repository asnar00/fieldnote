#!/usr/bin/env python3
"""Extract audio from a video file and transcribe it with MLX Whisper (Apple GPU)."""
import sys
import json
import mlx_whisper

def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "No file provided"}))
        sys.exit(1)

    video_path = sys.argv[1]
    prompt = sys.argv[2] if len(sys.argv) > 2 else None
    result = mlx_whisper.transcribe(
        video_path,
        path_or_hf_repo="mlx-community/whisper-large-v3-turbo",
        initial_prompt=prompt
    )
    print(json.dumps({"text": result["text"].strip()}))

if __name__ == "__main__":
    main()
