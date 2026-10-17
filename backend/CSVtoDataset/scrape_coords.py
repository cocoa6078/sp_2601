import os
import json
import requests
from bs4 import BeautifulSoup

def scrape_tmt_intersections():
    base_url = "https://www.tmt.or.jp/research/index10_1_{}.html"
    
    scraped_data = []

    headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    }

    for page_num in range(1, 6):
        url = base_url.format(page_num)
        print(f"[{url}] スクレイピング中...")
        
        try:
            response = requests.get(url, headers=headers, timeout=10)
            response.encoding = 'utf-8'
            
            if response.status_code != 200:
                print(f"  -> アクセス失敗 (ステータス: {response.status_code})")
                continue
                
            soup = BeautifulSoup(response.text, 'html.parser')
            
            options = soup.select('select.intersection_id option')
            
            count = 0
            for opt in options:
                isect_num = opt.text.strip()
                lat = opt.get('lat')
                lon = opt.get('lon')
                
                if isect_num and isect_num != '－' and lat and lon:
                    scraped_data.append({
                        "page_id": page_num,
                        "交差点番号": int(isect_num),
                        "緯度": float(lat),
                        "経度": float(lon)
                    })
                    count += 1
                    
            print(f"  -> {count} 件の交差点座標を抽出しました。")
            
        except Exception as e:
            print(f"  -> エラー発生: {e}")

    output_path = "./backend/scraped_coordinates.json"
    with open(output_path, 'w', encoding='utf-8') as f:
        json.dump(scraped_data, f, ensure_ascii=False, indent=2)
    print(f"\n✅ スクレイピング完了！結果保存: {output_path}")

if __name__ == "__main__":
    scrape_tmt_intersections()