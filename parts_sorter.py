import pandas as pd

# Read the original Excel file
input_file = r'C:\Users\Xiaomi\Desktop\Work\JD1.xlsx'  # Use the full file path
  # Replace with your file path
output_file = 'JD_clean.xlsx'  # Replace with desired output file path

# Load the Excel file into a pandas DataFrame
df = pd.read_excel(input_file)

# Filter rows where "Работа через сток" column contains "Да"
filtered_df = df[df['Работа через сток'] == 'Да'].head(12)

# Save the filtered DataFrame to a new Excel file
filtered_df.to_excel(output_file, index=False)

print(f"Filtered data has been saved to {output_file}")
