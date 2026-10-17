import pandas as pd
import json
import os
import glob

# メッシュコード(6桁)から緯度・経度（中心点）を概算する関数
def mesh_to_latlon(mesh_code):
    try:
        mesh_str = str(int(float(mesh_code)))
        if len(mesh_str) != 6:
            return None, None
            
        p = int(mesh_str[0:2])
        u = int(mesh_str[2:4])
        q = int(mesh_str[4:5])
        v = int(mesh_str[5:6])
        
        # JIS X 0410に基づく概算緯度・経度
        lat = (p * 40 + q * 5) / 60.0 + (2.5 / 60.0)
        lon = (u + v * 7.5 / 60.0) + 100.0 + (3.75 / 60.0)
        return round(lat, 5), round(lon, 5)
    except:
        return None, None

def process_hokkaido_bigdata():
    regions = ['札幌方面', '函館方面', '旭川方面', '釧路方面', '北見方面']
    
    current_dir = os.path.dirname(os.path.abspath(__file__))
    base_dir = os.path.join(current_dir, 'data')
    
    all_signals = []
    
    for region in regions:
        # globを使用してあいまいなファイル名（隠し文字など）にも対応
        control_pattern = os.path.join(base_dir, f'*北海道警（{region}）_制御*.txt')
        define_pattern = os.path.join(base_dir, f'*北海道警（{region}）_定義*.txt')
        
        ctrl_files = glob.glob(control_pattern)
        def_files = glob.glob(define_pattern)
        
        if not ctrl_files or not def_files:
            print(f"⚠️ [{region}] のファイルセットが見つかりません。")
            continue
            
        print(f"\n[{region}] のデータを解析中...")
        
        # 1. 定義データのロード（交差点番号とメッシュコードの紐付け）
        mesh_mapping = {}
        try:
            # エンコーディングエラー回避のため、cp932とutf-8-sigの両方でフォールバック
            try:
                df_def = pd.read_csv(def_files[0], encoding='cp932', on_bad_lines='skip')
            except:
                df_def = pd.read_csv(def_files[0], encoding='utf-8-sig', on_bad_lines='skip')
                
            for _, row in df_def.iterrows():
                isect_id = str(row.get('交差点番号', '')).strip()
                mesh_code = row.get('流入リンク＃１定義_２次メッシュコード')
                if pd.notna(mesh_code) and isect_id:
                    mesh_mapping[isect_id] = mesh_code
        except Exception as e:
            print(f"  -> 定義ファイルの読み込みエラー: {e}")
            continue

        # 2. 制御データのパースと結合
        match_count = 0
        target_time = None
        
        try:
            with open(ctrl_files[0], 'r', encoding='cp932', errors='replace') as f:
                lines = f.readlines()
                
            # 自動デバッグ: ファイル内に実際に存在する「最初の時刻」を検知して設定する
            for line in lines[1:]:
                parts = line.strip().split(',')
                if len(parts) >= 11:
                    # 先頭のBOM（\ufeff）や見えない空白を完全に除去
                    target_time = parts[0].replace('\ufeff', '').strip()
                    print(f"  -> 自動検知された時刻 [{target_time}] のデータを抽出します...")
                    break
                    
            if not target_time:
                print("  -> 有効な時刻データが見つかりませんでした。")
                continue

            # 検知した時刻に一致するデータをすべて抽出
            for line in lines[1:]:
                parts = line.strip().split(',')
                if len(parts) >= 11:
                    current_time = parts[0].replace('\ufeff', '').strip()
                    
                    if current_time == target_time:
                        isect_id = str(parts[2]).strip()
                        
                        try:
                            cycle_len = int(parts[3])
                            s1_percent = float(parts[4]) if parts[4].strip() else 0.0
                        except ValueError:
                            continue
                            
                        green_dur = round(cycle_len * (s1_percent / 100))
                        
                        mesh_code = mesh_mapping.get(isect_id)
                        lat, lon = mesh_to_latlon(mesh_code) if mesh_code else (None, None)
                        
                        all_signals.append({
                            "地域": region,
                            "交差点番号": int(isect_id),
                            "メッシュコード": mesh_code,
                            "緯度": lat,
                            "経度": lon,
                            "サイクル長": cycle_len,
                            "青信号時間": green_dur,
                            "赤信号時間": cycle_len - green_dur
                        })
                        match_count += 1
                        
            print(f"  -> {match_count} 件のデータを抽出しました。")
            
        except Exception as e:
            print(f"  -> 制御ファイルのパースエラー: {e}")

    # 3. 統合出力
    if len(all_signals) == 0:
        print("\n❌ エラー: 条件に一致するデータが1件もありませんでした。ファイルの中身が空でないか確認してください。")
        return

    output_json = os.path.join(current_dir, 'hokkaido_all_signals.json')
    with open(output_json, 'w', encoding='utf-8') as f:
        json.dump(all_signals, f, ensure_ascii=False, indent=2)
        
    df_all = pd.DataFrame(all_signals)
    output_txt = os.path.join(current_dir, 'hokkaido_all_signals_data.txt')
    df_all.to_csv(output_txt, sep='\t', index=False, encoding='utf-8')
    
    print(f"\n✅ 処理完了: 合計 {len(all_signals)} 件の交差点データを抽出・統合しました。")
    print(f"📁 出力先: {output_json}")
    print(f"📁 出力先: {output_txt}")

if __name__ == "__main__":
    process_hokkaido_bigdata()