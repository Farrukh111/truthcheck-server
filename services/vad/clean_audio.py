# server/services/vad/clean_audio.py
import torch
import sys
import torchaudio
import os

def clean_audio(input_path, output_path):
    print(f"[VAD-Python] Loading model for {input_path}...")
    
    # Проверка существования файла
    if not os.path.exists(input_path):
        print(f"[VAD-Python] Error: Input file not found: {input_path}")
        sys.exit(1)

    try:
        # Загружаем модель (скачается 1 раз и закэшируется)
        model, utils = torch.hub.load(repo_or_dir='snakers4/silero-vad',
                                      model='silero_vad',
                                      force_reload=False,
                                      trust_repo=True)

        (get_speech_timestamps, save_audio, read_audio, VADIterator, collect_chunks) = utils

        # Читаем WAV (16kHz)
        wav = read_audio(input_path, sampling_rate=16000)
        
        # Ищем голос
        speech_timestamps = get_speech_timestamps(wav, model, sampling_rate=16000)
        
        if len(speech_timestamps) == 0:
            print("[VAD-Python] No speech detected!")
            # Если речи нет совсем, создаем пустой файл или выходим с ошибкой
            # Для надежности лучше выйти с ошибкой, чтобы воркер знал
            sys.exit(1)

        # Собираем куски с речью в один файл
        save_audio(output_path,
                   collect_chunks(speech_timestamps, wav), 
                   sampling_rate=16000)
        
        print("[VAD-Python] Success! Speech extracted.")

    except Exception as e:
        print(f"[VAD-Python] Critical Error: {str(e)}")
        sys.exit(1)

if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("Usage: python clean_audio.py <input> <output>")
        sys.exit(1)
        
    clean_audio(sys.argv[1], sys.argv[2])